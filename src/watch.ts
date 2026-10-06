/**
 * Eine Runde: Kurse, Meldungen, rein oder raus.
 * Orders nur bei offener US-Börse und nur wenn die Entscheidung kippt.
 * Cash und Stückzahl ändern sich hier nicht. Das macht der Fill-Abgleich.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ALPACA = "https://paper-api.alpaca.markets/v2";
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";
const SYMBOLS = ["SPY", "QQQ", "NVDA", "AMD", "MSFT", "AAPL", "TQQQ", "SOXL", "NVDL"];
const HEBEL = new Set(["TQQQ", "SOXL", "NVDL", "TSLL", "UPRO"]);
const SHOCK = /\b(crash|plunge|plunges|war|invasion|missile|explosion|bankruptcy|bankrupt|trading halt|halted|indictment|recession|earthquake|assassination|sanctions)\b/i;
const HARD = /\b(trading halt|market crash|crash|invasion|missile|war|bankruptcy|bankrupt|earthquake|assassination)\b/i;
const SOFT = /\b(what to|what if|explainer|opinion|could|may |might|forecast|preview|week ahead|if |is coming|advice|how to)\b/i;
const MARKET = /\b(stock market|s&p|nasdaq|wall street|dow|trading halt)\b/i;

type Pos = { symbol: string; qty: number; entry: number; sleeve: string; stop?: number };
type State = { book: string; cash: number; positions: Pos[] };
type Call = "REIN" | "RAUS" | "BLEIBEN" | "DRAUSSEN";

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`ENV ${name} fehlt`);
  return v;
}

function session(now = new Date()): "open" | "closed" {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (wd === "Sat" || wd === "Sun") return "closed";
  const mins = Number(parts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return mins >= 9 * 60 + 30 && mins < 16 * 60 ? "open" : "closed";
}

function shock(title: string, symbol: string | null) {
  if (!title || !SHOCK.test(title) || SOFT.test(title)) return false;
  if (symbol && new RegExp(`\\b${symbol}\\b`, "i").test(title)) return true;
  return HARD.test(title) && MARKET.test(title);
}

function decide(input: { held: boolean; last: number; prev: number | null; dayOpen: number | null; entry: number | null; shock: boolean; market: "open" | "closed"; hebel?: boolean }): { call: Call; reason: string } {
  const chg5 = input.prev && input.prev > 0 ? input.last / input.prev - 1 : null;
  const chgDay = input.dayOpen && input.dayOpen > 0 ? input.last / input.dayOpen - 1 : null;
  const chgEntry = input.entry && input.entry > 0 ? input.last / input.entry - 1 : null;
  const downFast = chg5 != null && chg5 <= (input.hebel ? -0.025 : -0.012);
  const upFast = chg5 != null && chg5 >= 0.008 && (chgDay == null || chgDay > 0);
  const underWater = chgEntry != null && chgEntry <= -0.025;
  const dayBleed = input.hebel && chgDay != null && chgDay <= -0.04;
  if (input.market === "closed") {
    if (input.held && (input.shock || underWater || dayBleed)) {
      const reason = input.shock ? "Markt zu. Schockmeldung, bei Eröffnung raus." : dayBleed ? "Markt zu. Hebel hat am Tag 4 % abgegeben, bei Eröffnung raus." : "Markt zu. Unter dem Einstieg, bei Eröffnung raus.";
      return { call: "RAUS", reason };
    }
    return { call: input.held ? "BLEIBEN" : "DRAUSSEN", reason: "Markt zu. Keine Order." };
  }
  if (input.held && input.shock) return { call: "RAUS", reason: "Schockmeldung. Sofort raus." };
  if (input.held && underWater) return { call: "RAUS", reason: "Unter dem Einstieg. Verlust begrenzen." };
  if (input.held && dayBleed) return { call: "RAUS", reason: "Hebel gibt heute 4 % ab." };
  if (input.held && downFast) return { call: "RAUS", reason: "Dreht nach unten. Sofort raus." };
  if (!input.held && input.shock) return { call: "DRAUSSEN", reason: "Schockmeldung. Nicht reingehen." };
  if (!input.held && upFast) return { call: "REIN", reason: "Steigt schon, keine Schockmeldung." };
  if (input.held) return { call: "BLEIBEN", reason: "Kein Kippen. Drin bleiben." };
  return { call: "DRAUSSEN", reason: "Steigt nicht klar. Draußen bleiben." };
}

async function alpaca(path: string, init: RequestInit = {}) {
  const res = await fetch(`${ALPACA}${path}`, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": env("ALPACA_API_KEY"),
      "APCA-API-SECRET-KEY": env("ALPACA_SECRET_KEY"),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Alpaca ${path}: HTTP ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

function load(book: string): State {
  const file = `data/state-${book}.json`;
  if (!existsSync(file)) return { book, cash: 0, positions: [] };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return { book, cash: Number(raw.cash) || 0, positions: Array.isArray(raw.positions) ? raw.positions : [] };
}

function journal(book: string, entry: Record<string, unknown>) {
  mkdirSync("data", { recursive: true });
  appendFileSync(`data/journal-${book}.jsonl`, JSON.stringify({ ts: new Date().toISOString(), book, ...entry }) + "\n");
}

async function headlines(): Promise<string[]> {
  const res = await fetch("https://news.google.com/rss/search?q=stock+market+OR+NVDA+OR+SPY+when:1d&hl=en-US&gl=US&ceid=US:en", { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const xml = await res.text();
  const titles: string[] = [];
  for (const item of xml.split("<item>").slice(1)) {
    const match = item.match(/<title>([\s\S]*?)<\/title>/);
    const title = (match?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&/g, "&").replace(/&#39;/g, "'").replace(/"/g, '"').trim();
    if (!title || /stock price|quote & history|yahoo! finance|google news/i.test(title)) continue;
    titles.push(title);
    if (titles.length >= 6) break;
  }
  return titles;
}

async function quote(symbol: string) {
  const res = await fetch(`${YAHOO}/${encodeURIComponent(symbol)}?range=1d&interval=1m`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  const body = await res.json() as { chart?: { result?: { indicators?: { quote?: { close?: (number | null)[] }[] } }[] } };
  const px = (body.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((n): n is number => n != null && n > 0);
  if (!px.length) return null;
  const last = px[px.length - 1]!;
  const prev = px.length > 15 ? px[px.length - 16]! : px.length > 5 ? px[px.length - 6]! : null;
  return { last, prev, open: px[0] ?? null };
}

async function longVote(symbol: string) {
  const res = await fetch(`${YAHOO}/${encodeURIComponent(symbol)}?range=15y&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  const body = await res.json() as { chart?: { result?: { indicators?: { quote?: { close?: (number | null)[] }[] } }[] } };
  const px = (body.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((n): n is number => n != null && n > 0);
  if (px.length < 200) return null;
  const last = px[px.length - 1]!;
  const back = (n: number) => px.length > n && px[px.length - 1 - n]! > 0 ? last / px[px.length - 1 - n]! - 1 : null;
  const sma = px.slice(-200).reduce((a, b) => a + b, 0) / 200;
  let cash = 1, shares = 0;
  const start = Math.max(200, px.length - 252);
  for (let i = start; i < px.length; i++) {
    let sum = 0;
    for (let k = i - 200; k < i; k++) sum += px[k]!;
    const line = sum / 200;
    const price = px[i]!;
    if (shares === 0 && price > line) { shares = cash / price; cash = 0; }
    else if (shares > 0 && price < line) { cash = shares * price; shares = 0; }
  }
  const trendYear = px.length >= 220 ? cash + shares * last - 1 : null;
  return { week: back(5), month: back(21), year: back(252), aboveSma: last > sma, trendYear };
}

function agreed(symbol: string, call: Call, reason: string, vote: { week: number | null; month?: number | null; year: number | null; aboveSma: boolean; trendYear?: number | null } | null, position?: { last: number; stop?: number; sleeve?: string }): { call: Call; reason: string } {
  const stop = position?.stop;
  if (stop != null && stop > 0 && position != null && position.last <= stop && call !== "RAUS" && call !== "DRAUSSEN") {
    return { call: "RAUS", reason: "Stop ist erreicht." };
  }
  const sleeve = position?.sleeve;
  if (call === "BLEIBEN" && sleeve === "sat") {
    return { call: "RAUS", reason: "Einzelwert raus. Die Regel hat seit 2022 verloren." };
  }
  if (call === "BLEIBEN" && vote?.aboveSma === false && (sleeve === "core" || sleeve === "hebel" || symbol === "SPY" || HEBEL.has(symbol))) {
    return { call: "RAUS", reason: "Unter SMA200." };
  }
  if (call !== "REIN") return { call, reason };
  const hebel = HEBEL.has(symbol);
  const core = symbol === "SPY";
  if (!hebel && !core) return { call: "DRAUSSEN", reason: "Lehre: Einzelwerte seit 2022 −12,4 %, Profitfaktor 0,01. Kein neuer Kauf." };
  const weekOk = vote?.week != null && vote.week > -0.04;
  const monthOk = vote?.month == null || vote.month > -0.08;
  const yearOk = vote?.year != null && vote.year > 0 && vote.aboveSma === true;
  const trendOk = vote?.trendYear == null || vote.trendYear >= 0;
  if (!weekOk || !monthOk || !yearOk || !trendOk) {
    const why = !yearOk ? "Jahr oder SMA200 nicht intakt. Nicht rein." : !monthOk ? "Der letzte Monat ist zu schwach. Nicht rein." : !trendOk ? "Die Trend-Regel hat im letzten Jahr verloren. Nicht rein." : "Letzte Woche zu schwach. Nicht rein.";
    return { call: "DRAUSSEN", reason: why };
  }
  return { call: "REIN", reason: `Woche, Jahr und SMA200 einig. ${reason}` };
}


async function main() {
  const market = session();
  const heads = await headlines();
  const lead = heads[0] ?? null;
  const states = ["main", "hebel"].map(load);
  const held = new Map<string, { book: string; pos: Pos }>();
  for (const state of states) for (const pos of state.positions) held.set(pos.symbol, { book: state.book, pos });

  const notes: { symbol: string; call: Call; reason: string }[] = [];
  for (const symbol of SYMBOLS) {
    const q = await quote(symbol);
    if (!q) {
      notes.push({ symbol, call: "DRAUSSEN", reason: "Kurs fehlt." });
      continue;
    }
    const own = heads.find((title) => new RegExp(`\\b${symbol}\\b`, "i").test(title)) ?? null;
    const hit = shock(own ?? "", symbol) || (lead != null && shock(lead, null));
    const have = held.get(symbol);
    const d0 = decide({ held: Boolean(have), last: q.last, prev: q.prev, dayOpen: q.open, entry: have?.pos.entry ?? null, shock: hit, market, hebel: HEBEL.has(symbol) });
    const vote = have || d0.call === "REIN" ? await longVote(symbol) : null;
    const d = agreed(symbol, d0.call, d0.reason, vote, have ? { last: q.last, stop: have.pos.stop, sleeve: have.pos.sleeve } : undefined);
    notes.push({ symbol, call: d.call, reason: d.reason });
  }

  const watchFile = "data/watch.json";
  const prev = existsSync(watchFile) ? JSON.parse(readFileSync(watchFile, "utf8")) : {};
  const exitAtOpen = new Set<string>(Array.isArray(prev.exitAtOpen) ? prev.exitAtOpen : []);
  for (const note of notes) {
    if (note.call === "RAUS") exitAtOpen.add(note.symbol);
    if (note.call === "BLEIBEN") exitAtOpen.delete(note.symbol);
  }

  const sent: { symbol: string; side: string; orderId?: string; status?: string; error?: string }[] = [];
  if (market === "open") {
    const openOrders: { symbol?: string; side?: string }[] = await alpaca("/orders?status=open&limit=50");
    const broker: { symbol: string; qty: number }[] = (await alpaca("/positions")).map((x: { symbol: string; qty: string }) => ({ symbol: x.symbol, qty: parseFloat(x.qty) }));
    const openFor = (symbol: string, side: string) => openOrders.some((o) => o.symbol === symbol && (o.side ?? "").toLowerCase() === side);

    for (const symbol of [...exitAtOpen]) {
      const have = held.get(symbol);
      if (!have) { exitAtOpen.delete(symbol); continue; }
      if (openFor(symbol, "sell")) { sent.push({ symbol, side: "sell", status: "liegt schon" }); continue; }
      const qty = Math.min(have.pos.qty, broker.find((b) => b.symbol === symbol)?.qty ?? 0);
      if (!(qty > 1e-6)) { sent.push({ symbol, side: "sell", status: "Broker hat keine Stücke" }); continue; }
      try {
        const o = await alpaca("/orders", { method: "POST", body: JSON.stringify({ symbol, side: "sell", type: "market", time_in_force: "day", qty: qty.toString() }) });
        journal(have.book, { type: "order", symbol, side: "SELL", orderId: o.id, qty, status: o.status, reason: notes.find((n) => n.symbol === symbol)?.reason ?? "Ausstieg" });
        sent.push({ symbol, side: "sell", orderId: o.id, status: o.status });
        openOrders.push({ symbol, side: "sell" });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        journal(have.book, { type: "order_error", symbol, error });
        sent.push({ symbol, side: "sell", error });
      }
    }

    for (const note of notes) {
      if (note.call !== "REIN" || held.has(note.symbol) || openFor(note.symbol, "buy")) continue;
      const book = HEBEL.has(note.symbol) ? "hebel" : "main";
      const state = states.find((s) => s.book === book)!;
      if (state.cash < 30 || state.positions.length >= 4) {
        sent.push({ symbol: note.symbol, side: "buy", status: "kein Platz oder kein Cash" });
        continue;
      }
      try {
        const o = await alpaca("/orders", { method: "POST", body: JSON.stringify({ symbol: note.symbol, side: "buy", type: "market", time_in_force: "day", notional: "30.00" }) });
        journal(book, { type: "order", symbol: note.symbol, side: "BUY", orderId: o.id, notional: 30, status: o.status, reason: note.reason });
        sent.push({ symbol: note.symbol, side: "buy", orderId: o.id, status: o.status });
        state.cash -= 30;
        state.positions.push({ symbol: note.symbol, qty: 0, entry: 0, sleeve: book });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        journal(book, { type: "order_error", symbol: note.symbol, error });
        sent.push({ symbol: note.symbol, side: "buy", error });
      }
    }
  }

  for (const state of states) {
    const mine = notes.filter((n) => held.get(n.symbol)?.book === state.book || (n.call === "REIN" && (HEBEL.has(n.symbol) ? state.book === "hebel" : state.book === "main")));
    journal(state.book, { type: "watch", market, headline: lead, notes: mine, sent: sent.filter((s) => held.get(s.symbol)?.book === state.book || (HEBEL.has(s.symbol) ? state.book === "hebel" : state.book === "main")) });
  }

  writeFileSync(watchFile, JSON.stringify({
    at: new Date().toISOString(),
    market,
    headline: lead,
    notes,
    sent,
    exitAtOpen: [...exitAtOpen],
  }, null, 2));
  console.log(JSON.stringify({ market, headline: lead, notes, sent, exitAtOpen: [...exitAtOpen] }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
