/**
 * Vesper Autopilot – Paper only.
 *
 * Läuft einmal pro Aufruf (GitHub-Actions-Cron nach US-Close):
 *   Konto lesen → Positionen abgleichen → Tageskerzen holen → Stops prüfen
 *   → Strategie-Signale → Risk-Gate (deterministisch) → Orders an Alpaca PAPER
 *   → Journal (data/journal-<book>.jsonl, data/state-<book>.json) → Telegram.
 *
 * Fail-closed: fehlen Daten, antwortet Alpaca nicht oder ist etwas inkonsistent
 * → ABSTAIN, kein Trade, Fehler per Telegram.
 *
 * Es gibt KEINEN Live-Endpoint in dieser Datei.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { askVesper, type MarketRow } from "./vesper.js";

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

const ALPACA = "https://paper-api.alpaca.markets/v2"; // einziger Endpoint
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";

const BOOK = (process.env.BOOK ?? "main") as "main" | "hebel";
const CHECK_ONLY = process.argv.includes("--check");
const VESPER_ON = (process.env.VESPER ?? "on") !== "off"; // VESPER=off → reines Regelwerk

const START_CAPITAL = 300;

// Book "main": Core-Satellite Trend + Momentum
const MAIN = {
  coreSymbol: "SPY",
  coreShare: 0.6,
  coreSma: 200,
  satShare: 0.4,
  satUniverse: ["META","AAPL","MSFT","NVDA","GOOGL","AMZN","AVGO","JPM","BLK","TSLA",
                "LLY","V","MA","COST","NFLX","AMD","UNH","XOM","HD","PG"],
  satTop: 3,
  satMomentumDays: 126,
  satSma: 100,
  atrMult: 2.5,
  maxPositionPct: 0.20,
  dailyDrawdownHalt: 0.03,
  totalDrawdownHalt: 0.15,
  maxHoldDays: Infinity,
};

// Book "hebel": Sleeve A – Hebel-ETFs mit Basiswert-Filter (echte Fills)
const HEBEL = {
  pairs: [
    { lev: "TQQQ", base: "QQQ"  },
    { lev: "SOXL", base: "SOXX" },
    { lev: "NVDL", base: "NVDA" },
    { lev: "TSLL", base: "TSLA" },
    { lev: "UPRO", base: "SPY"  },
  ],
  sma1: 50,
  sma2: 200,
  rsiMax: 70,
  maxPositionPct: 0.15,
  maxPositions: 3,
  maxHoldDays: 10,
  atrMult: 3.0,
  dailyDrawdownHalt: 0.05,
  totalDrawdownHalt: 0.25,
};

// ─────────────────────────────────────────────────────────────────────────────
// Typen
// ─────────────────────────────────────────────────────────────────────────────

type Bar = { date: string; open: number; high: number; low: number; close: number };
type Position = {
  symbol: string; sleeve: string; qty: number; entry: number; entryDate: string;
  stop: number; peak: number;
};
type State = {
  book: string; startCapital: number; cash: number; positions: Position[];
  equityHistory: { date: string; equity: number }[]; peakEquity: number;
  haltedUntil: string | null; lastRebalanceMonth: string | null; lastRun: string | null;
};
type Decision = {
  symbol: string; action: "BUY" | "SELL" | "HOLD" | "ABSTAIN"; sleeve: string;
  reason: string; notional?: number; qty?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Hilfsfunktionen
// ─────────────────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);
const month = (d: string) => d.slice(0, 7);
const r2 = (n: number) => Math.round(n * 100) / 100;

function env(name: string, required = true): string {
  const v = process.env[name];
  if (!v && required) throw new Error(`ENV ${name} fehlt`);
  return v ?? "";
}

function sma(bars: Bar[], n: number): number | null {
  if (bars.length < n) return null;
  const s = bars.slice(-n).reduce((a, b) => a + b.close, 0);
  return s / n;
}

function atr(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    sum += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  return sum / n;
}

function rsi(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function momentum(bars: Bar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  return bars[bars.length - 1].close / bars[bars.length - 1 - n].close - 1;
}

function isFresh(bars: Bar[]): boolean {
  // Letzte Kerze darf höchstens 4 Kalendertage alt sein (Wochenende + Feiertag)
  const last = new Date(bars[bars.length - 1].date).getTime();
  return Date.now() - last < 4 * 86400_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daten: Yahoo
// ─────────────────────────────────────────────────────────────────────────────

async function yahooBars(symbol: string): Promise<Bar[]> {
  const url = `${YAHOO}/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const j: any = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo ${symbol}: keine Daten`);
  const q = r.indicators.quote[0];
  const bars: Bar[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    bars.push({
      date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
    });
  }
  if (bars.length < 210) throw new Error(`Yahoo ${symbol}: nur ${bars.length} Kerzen`);
  if (!isFresh(bars)) throw new Error(`Yahoo ${symbol}: Tape nicht frisch (${bars[bars.length - 1].date})`);
  return bars;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alpaca PAPER
// ─────────────────────────────────────────────────────────────────────────────

async function alpaca(path: string, init: RequestInit = {}): Promise<any> {
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
  if (!res.ok) throw new Error(`Alpaca ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function alpacaAccount() {
  const a = await alpaca("/account");
  if (a.trading_blocked || a.account_blocked) throw new Error("Alpaca: Konto gesperrt");
  return a;
}

async function alpacaPositions(): Promise<{ symbol: string; qty: number; avg: number; price: number }[]> {
  const p = await alpaca("/positions");
  return p.map((x: any) => ({
    symbol: x.symbol, qty: parseFloat(x.qty), avg: parseFloat(x.avg_entry_price), price: parseFloat(x.current_price),
  }));
}

async function alpacaOrder(symbol: string, side: "buy" | "sell", opts: { notional?: number; qty?: number }) {
  const body: any = { symbol, side, type: "market", time_in_force: "day" };
  if (opts.notional) body.notional = r2(opts.notional).toFixed(2);
  if (opts.qty) body.qty = opts.qty.toString();
  return alpaca("/orders", { method: "POST", body: JSON.stringify(body) });
}

// ─────────────────────────────────────────────────────────────────────────────
// State + Journal
// ─────────────────────────────────────────────────────────────────────────────

const STATE_FILE = `data/state-${BOOK}.json`;
const JOURNAL_FILE = `data/journal-${BOOK}.jsonl`;

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  return {
    book: BOOK, startCapital: START_CAPITAL, cash: START_CAPITAL, positions: [],
    equityHistory: [], peakEquity: START_CAPITAL, haltedUntil: null,
    lastRebalanceMonth: null, lastRun: null,
  };
}

function saveState(s: State) {
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function journal(entry: Record<string, unknown>) {
  mkdirSync("data", { recursive: true });
  appendFileSync(JOURNAL_FILE, JSON.stringify({ ts: new Date().toISOString(), book: BOOK, ...entry }) + "\n");
}

function recentJournal(n = 20): unknown[] {
  if (!existsSync(JOURNAL_FILE)) return [];
  return readFileSync(JOURNAL_FILE, "utf8").trim().split("\n").filter(Boolean).slice(-n)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function loadBlackout(): Set<string> {
  try { return new Set(JSON.parse(readFileSync("data/blackout.json", "utf8")).dates); }
  catch { return new Set(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram
// ─────────────────────────────────────────────────────────────────────────────

async function telegram(text: string) {
  const token = env("TELEGRAM_BOT_TOKEN", false), chat = env("TELEGRAM_CHAT_ID", false);
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { console.error("Telegram:", e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategie: Book MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function strategyMain(state: State, bars: Map<string, Bar[]>, equity: number): Promise<Decision[]> {
  const d: Decision[] = [];
  const spy = bars.get(MAIN.coreSymbol)!;
  const spyClose = spy[spy.length - 1].close;
  const spySma = sma(spy, MAIN.coreSma)!;
  const corePos = state.positions.find(p => p.symbol === MAIN.coreSymbol);

  // Core
  if (spyClose > spySma && !corePos) {
    d.push({ symbol: MAIN.coreSymbol, action: "BUY", sleeve: "core",
      notional: equity * MAIN.coreShare, reason: `SPY ${r2(spyClose)} > SMA200 ${r2(spySma)}` });
  } else if (spyClose <= spySma && corePos) {
    d.push({ symbol: MAIN.coreSymbol, action: "SELL", sleeve: "core", qty: corePos.qty,
      reason: `SPY ${r2(spyClose)} <= SMA200 ${r2(spySma)}` });
  } else {
    d.push({ symbol: MAIN.coreSymbol, action: "HOLD", sleeve: "core",
      reason: corePos ? "im Trend, halten" : "unter SMA200, Cash" });
  }

  // Satellite: nur am Monatsende (letzter Lauf des Monats) neu ranken
  const t = today();
  const isMonthEnd = (() => {
    const next = new Date(); next.setUTCDate(next.getUTCDate() + 1);
    // Freitag vor Monatswechsel oder letzter Tag: nächster Handelstag liegt im neuen Monat
    let n = new Date(); do { n.setUTCDate(n.getUTCDate() + 1); } while (n.getUTCDay() === 0 || n.getUTCDay() === 6);
    return month(n.toISOString().slice(0, 10)) !== month(t);
  })();

  if (!isMonthEnd || state.lastRebalanceMonth === month(t)) {
    return d;
  }

  const ranked = MAIN.satUniverse
    .map(s => ({ s, b: bars.get(s)! }))
    .filter(x => x.b)
    .map(x => ({ s: x.s, mom: momentum(x.b, MAIN.satMomentumDays)!, above: x.b[x.b.length - 1].close > (sma(x.b, MAIN.satSma) ?? Infinity) }))
    .sort((a, b) => b.mom - a.mom);
  const picks = ranked.slice(0, MAIN.satTop).filter(x => x.above).map(x => x.s);

  for (const p of state.positions.filter(p => p.sleeve === "sat")) {
    if (!picks.includes(p.symbol))
      d.push({ symbol: p.symbol, action: "SELL", sleeve: "sat", qty: p.qty, reason: "nicht mehr in Top-3 / unter SMA100" });
  }
  const perPick = (equity * MAIN.satShare) / MAIN.satTop;
  for (const s of picks) {
    if (!state.positions.find(p => p.symbol === s))
      d.push({ symbol: s, action: "BUY", sleeve: "sat", notional: perPick,
        reason: `Momentum-Top3 (${r2(ranked.find(x => x.s === s)!.mom * 100)} % / 126d), > SMA100` });
  }
  state.lastRebalanceMonth = month(t);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategie: Book HEBEL (Sleeve A, Hebel-ETF)
// ─────────────────────────────────────────────────────────────────────────────

async function strategyHebel(state: State, bars: Map<string, Bar[]>, equity: number): Promise<Decision[]> {
  const d: Decision[] = [];
  let open = state.positions.length;
  for (const { lev, base } of HEBEL.pairs) {
    const b = bars.get(base)!, close = b[b.length - 1].close;
    const s1 = sma(b, HEBEL.sma1)!, s2 = sma(b, HEBEL.sma2)!, r = rsi(b)!;
    const pos = state.positions.find(p => p.symbol === lev);
    const trendOk = close > s1 && close > s2;
    if (pos) {
      const held = Math.round((Date.now() - new Date(pos.entryDate).getTime()) / 86400_000);
      if (!trendOk) d.push({ symbol: lev, action: "SELL", sleeve: "hebel", qty: pos.qty, reason: `${base} unter SMA50/200` });
      else if (held >= HEBEL.maxHoldDays) d.push({ symbol: lev, action: "SELL", sleeve: "hebel", qty: pos.qty, reason: `max. Haltedauer ${HEBEL.maxHoldDays} Tage` });
      else d.push({ symbol: lev, action: "HOLD", sleeve: "hebel", reason: "Trend intakt" });
    } else if (trendOk && r < HEBEL.rsiMax && open < HEBEL.maxPositions) {
      d.push({ symbol: lev, action: "BUY", sleeve: "hebel", notional: equity * HEBEL.maxPositionPct,
        reason: `${base} > SMA50 & SMA200, RSI ${r2(r)}` });
      open++;
    } else {
      d.push({ symbol: lev, action: "HOLD", sleeve: "hebel", reason: trendOk ? `RSI ${r2(r)} / Limit Positionen` : `${base} kein Trend` });
    }
  }
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk-Gate (deterministisch – darf nur ablehnen oder verkleinern)
// ─────────────────────────────────────────────────────────────────────────────

function riskGate(state: State, decisions: Decision[], equity: number, blackout: Set<string>): Decision[] {
  const cfg = BOOK === "main" ? MAIN : HEBEL;
  const t = today();
  const out: Decision[] = [];
  const halted = state.haltedUntil && state.haltedUntil >= t;
  let cash = state.cash;

  for (const d of decisions) {
    if (d.action !== "BUY") { out.push(d); continue; }
    if (halted) { out.push({ ...d, action: "ABSTAIN", reason: `GATE: Halt bis ${state.haltedUntil} – ${d.reason}` }); continue; }
    if (blackout.has(t)) { out.push({ ...d, action: "ABSTAIN", reason: `GATE: Event-Blackout – ${d.reason}` }); continue; }
    let notional = Math.min(d.notional ?? 0, equity * cfg.maxPositionPct, cash);
    if (notional < 1) { out.push({ ...d, action: "ABSTAIN", reason: `GATE: kein Cash (${r2(cash)} $) – ${d.reason}` }); continue; }
    cash -= notional;
    out.push({ ...d, notional: r2(notional), reason: `${d.reason} | Gate: ${r2(notional)} $` });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hauptlauf
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const state = loadState();
  const t = today();
  const cfg = BOOK === "main" ? MAIN : HEBEL;
  const log: string[] = [`<b>Vesper ${BOOK}</b> · ${t}`];

  // 1. Konto
  const account = await alpacaAccount();
  const broker = await alpacaPositions();

  // 2. Abgleich Book ↔ Broker (Book ist Teilmenge des 100k-Paper-Kontos)
  for (const p of state.positions) {
    const b = broker.find(x => x.symbol === p.symbol);
    if (!b || b.qty + 1e-6 < p.qty) throw new Error(`Abgleich: ${p.symbol} im Book (${p.qty}) aber nicht/zu wenig beim Broker`);
  }

  // 3. Kurse
  const symbols = BOOK === "main"
    ? [MAIN.coreSymbol, ...MAIN.satUniverse]
    : [...new Set(HEBEL.pairs.flatMap(p => [p.lev, p.base]))];
  const bars = new Map<string, Bar[]>();
  const failed: string[] = [];
  for (const s of symbols) {
    try { bars.set(s, await yahooBars(s)); } catch (e: any) { failed.push(`${s}: ${e.message}`); }
  }
  const critical = BOOK === "main" ? [MAIN.coreSymbol] : HEBEL.pairs.flatMap(p => [p.lev, p.base]);
  if (critical.some(s => !bars.has(s))) throw new Error(`Kursdaten fehlen: ${failed.join("; ")}`);
  if (failed.length) log.push(`⚠ ohne Daten: ${failed.length} Symbole`);

  // 4. Mark-to-Market
  const price = (s: string) => bars.get(s)![bars.get(s)!.length - 1].close;
  let equity = state.cash + state.positions.reduce((a, p) => a + p.qty * (bars.has(p.symbol) ? price(p.symbol) : p.entry), 0);
  const prevEq = state.equityHistory.at(-1)?.equity ?? state.startCapital;
  const dayChange = equity / prevEq - 1;
  state.peakEquity = Math.max(state.peakEquity, equity);
  const totalDD = 1 - equity / state.peakEquity;

  // 5. Drawdown-Halt
  if (-dayChange >= cfg.dailyDrawdownHalt) {
    const until = new Date(); until.setUTCDate(until.getUTCDate() + (BOOK === "hebel" ? 2 : 1));
    state.haltedUntil = until.toISOString().slice(0, 10);
    log.push(`🛑 Tages-Drawdown ${r2(dayChange * 100)} % → Käufe gesperrt bis ${state.haltedUntil}`);
  }
  if (totalDD >= cfg.totalDrawdownHalt) {
    state.haltedUntil = "9999-12-31";
    log.push(`🛑 Gesamt-Drawdown ${r2(totalDD * 100)} % → Book gestoppt`);
  }

  // 6. Stops (Trailing ATR) – immer, auch wenn gehalten
  const decisions: Decision[] = [];
  for (const p of state.positions) {
    if (!bars.has(p.symbol)) continue;
    const b = bars.get(p.symbol)!, c = price(p.symbol);
    const stopBase = BOOK === "hebel" ? bars.get(HEBEL.pairs.find(x => x.lev === p.symbol)!.base)! : b;
    const a = atr(stopBase)!;
    const scale = BOOK === "hebel" ? c / stopBase[stopBase.length - 1].close * 3 : 1; // grob 3× Hebel
    p.peak = Math.max(p.peak, c);
    p.stop = Math.max(p.stop, p.peak - cfg.atrMult * a * scale);
    if (c <= p.stop) decisions.push({ symbol: p.symbol, action: "SELL", sleeve: p.sleeve, qty: p.qty, reason: `Stop ${r2(p.stop)} getroffen (${r2(c)})` });
  }

  // 7. Strategie
  const stratDecisions = BOOK === "main" ? await strategyMain(state, bars, equity) : await strategyHebel(state, bars, equity);
  for (const d of stratDecisions) if (!decisions.find(x => x.symbol === d.symbol && x.action === "SELL")) decisions.push(d);

  // 8. Risk-Gate
  const gated = riskGate(state, decisions, equity, loadBlackout());

  // 8b. Vesper (KI) – darf Käufe bestätigen oder ablehnen, sonst nichts. Fail-closed.
  let final = gated;
  const buys = gated.filter(d => d.action === "BUY");
  if (VESPER_ON && buys.length) {
    const market: MarketRow[] = symbols.filter(s => bars.has(s)).map(s => {
      const b = bars.get(s)!;
      return { symbol: s, close: r2(b.at(-1)!.close), sma50: sma(b, 50) && r2(sma(b, 50)!), sma200: sma(b, 200) && r2(sma(b, 200)!),
        mom126: momentum(b, 126) && r2(momentum(b, 126)! * 100), rsi14: rsi(b) && r2(rsi(b)!), atr14: atr(b) && r2(atr(b)!),
        dayChange: r2((b.at(-1)!.close / b.at(-2)!.close - 1) * 100) };
    });
    try {
      const v = await askVesper({ book: BOOK, date: t, equity: r2(equity), cash: r2(state.cash), drawdownPct: r2(totalDD * 100),
        market, candidates: gated, memory: recentJournal(20) });
      journal({ type: "vesper", outlook: v.outlook, verdicts: v.verdicts });
      final = gated.map(d => {
        if (d.action !== "BUY") return d;
        const verdict = v.verdicts.find(x => x.symbol === d.symbol);
        if (verdict?.verdict === "VETO") return { ...d, action: "ABSTAIN" as const, reason: `VESPER VETO (${verdict.confidence}): ${verdict.reason} | ${d.reason}` };
        return { ...d, reason: `${d.reason} | Vesper ${verdict ? `CONFIRM ${verdict.confidence}` : "kein Urteil → CONFIRM"}` };
      });
      if (v.outlook) log.push(`🧠 Vesper: ${v.outlook}`);
    } catch (e: any) {
      journal({ type: "vesper_error", error: e.message });
      final = gated.map(d => d.action === "BUY" ? { ...d, action: "ABSTAIN" as const, reason: `Vesper nicht erreichbar (${e.message}) – kein Kauf | ${d.reason}` } : d);
      log.push(`⚠ Vesper ausgefallen: ${e.message} → Käufe ausgesetzt`);
    }
  } else if (VESPER_ON && !buys.length) {
    // Kein Kauf-Kandidat: Vesper trotzdem ein Lagebild schreiben lassen (Gedächtnis füllen), Fehler sind hier unkritisch
    try {
      const v = await askVesper({ book: BOOK, date: t, equity: r2(equity), cash: r2(state.cash), drawdownPct: r2(totalDD * 100),
        market: [], candidates: gated, memory: recentJournal(20) });
      journal({ type: "vesper", outlook: v.outlook, verdicts: [] });
      if (v.outlook) log.push(`🧠 Vesper: ${v.outlook}`);
    } catch (e: any) { journal({ type: "vesper_error", error: e.message }); }
  }

  // 9. Ausführung (Orders werden zur nächsten Eröffnung ausgeführt)
  for (const d of final) {
    journal({ type: "decision", ...d, equity: r2(equity), cash: r2(state.cash) });
    if (CHECK_ONLY || d.action === "HOLD" || d.action === "ABSTAIN") { if (d.action !== "HOLD") log.push(`• ${d.symbol} ${d.action}: ${d.reason}`); continue; }
    try {
      const o = d.action === "BUY"
        ? await alpacaOrder(d.symbol, "buy", { notional: d.notional })
        : await alpacaOrder(d.symbol, "sell", { qty: d.qty });
      journal({ type: "order", symbol: d.symbol, side: d.action, orderId: o.id, notional: d.notional, qty: d.qty, status: o.status });
      if (d.action === "BUY") {
        const c = price(d.symbol), qty = d.notional! / c, b = bars.get(d.symbol)!;
        const a = atr(b)!;
        state.positions.push({ symbol: d.symbol, sleeve: d.sleeve, qty: r2(qty * 10000) / 10000, entry: c, entryDate: t, stop: c - cfg.atrMult * a, peak: c });
        state.cash -= d.notional!;
        log.push(`🟢 BUY ${d.symbol} ${d.notional} $ – ${d.reason}`);
      } else {
        const p = state.positions.find(p => p.symbol === d.symbol)!;
        const c = price(d.symbol);
        state.cash += p.qty * c;
        state.positions = state.positions.filter(p => p.symbol !== d.symbol);
        log.push(`🔴 SELL ${d.symbol} ≈${r2(p.qty * c)} $ (${r2((c / p.entry - 1) * 100)} %) – ${d.reason}`);
      }
    } catch (e: any) {
      journal({ type: "order_error", symbol: d.symbol, error: e.message });
      log.push(`⚠ Order ${d.symbol} fehlgeschlagen: ${e.message}`);
    }
  }

  // 10. Equity-Historie + Report
  equity = state.cash + state.positions.reduce((a, p) => a + p.qty * (bars.has(p.symbol) ? price(p.symbol) : p.entry), 0);
  state.equityHistory.push({ date: t, equity: r2(equity) });
  state.lastRun = new Date().toISOString();
  if (!CHECK_ONLY) saveState(state);
  journal({ type: "equity", equity: r2(equity), cash: r2(state.cash), positions: state.positions.length, dayChange: r2(dayChange * 100), totalDD: r2(totalDD * 100) });

  const spyBars = bars.get("SPY");
  const spyDay = spyBars ? r2((spyBars.at(-1)!.close / spyBars.at(-2)!.close - 1) * 100) : null;
  log.push(`Stand <b>${r2(equity)} $</b> (${dayChange >= 0 ? "+" : ""}${r2(dayChange * 100)} % Tag${spyDay !== null ? `, SPY ${spyDay >= 0 ? "+" : ""}${spyDay} %` : ""})`);
  log.push(`Cash ${r2(state.cash)} $ · Positionen ${state.positions.length} · DD ${r2(totalDD * 100)} %`);
  for (const p of state.positions) log.push(`  ${p.symbol} ${r2(p.qty * price(p.symbol))} $ (Stop ${r2(p.stop)})`);
  log.push(`Alpaca Paper Equity gesamt: ${r2(parseFloat(account.equity))} $${CHECK_ONLY ? " · CHECK-Modus, keine Orders" : ""}`);
  console.log(log.join("\n"));
  await telegram(log.join("\n"));
}

main().catch(async (e) => {
  const msg = `<b>Vesper ${BOOK} – ABSTAIN</b>\nKein Trade. Grund: ${e.message}`;
  console.error(msg);
  journal({ type: "abstain", error: e.message });
  await telegram(msg);
  process.exit(1);
});
