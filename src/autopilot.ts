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
  ddHalt?: boolean;
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
  // Datum ohne Uhrzeit ist Mitternacht. Freitag bis Dienstag nach einem Feiertag
  // ist länger als 4 Tage und hat den Lauf früher komplett abgebrochen.
  const last = Date.parse(`${bars[bars.length - 1].date}T00:00:00Z`);
  return Date.now() - last < 6 * 86400_000;
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

function orderRecords(): { id: string; symbol: string; side: string; sleeve: string }[] {
  if (!existsSync(JOURNAL_FILE)) return [];
  const sleeveOf = new Map<string, string>();
  const seen = new Set<string>();
  const out: { id: string; symbol: string; side: string; sleeve: string }[] = [];
  for (const line of readFileSync(JOURNAL_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: { type?: string; symbol?: string; sleeve?: string; orderId?: string; side?: string };
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "decision" && row.symbol && row.sleeve) sleeveOf.set(row.symbol, row.sleeve);
    if (row.type === "order" && row.orderId && !seen.has(row.orderId)) {
      seen.add(row.orderId);
      out.push({
        id: row.orderId,
        symbol: row.symbol ?? "",
        side: (row.side ?? "").toLowerCase(),
        sleeve: sleeveOf.get(row.symbol ?? "") ?? (BOOK === "hebel" ? "hebel" : "core"),
      });
    }
  }
  return out;
}

/** Bestand und Cash nur aus gefüllten Orders. Accepted ist kein Geld. */
async function rebuildFromFills(state: State, log: string[]) {
  const records = orderRecords();
  if (!records.length) return;
  const lots = new Map<string, { symbol: string; sleeve: string; qty: number; cost: number; entryDate: string }>();
  let cash = state.startCapital;
  for (const rec of records) {
    const o = await alpaca(`/orders/${encodeURIComponent(rec.id)}`);
    const filled = parseFloat(o.filled_qty || "0");
    const avg = parseFloat(o.filled_avg_price || "0");
    const side = String(o.side || rec.side || "").toLowerCase();
    const symbol = String(o.symbol || rec.symbol || "");
    if (!(filled > 0) || !(avg > 0) || !symbol) {
      log.push(`${symbol || rec.symbol} ${side || rec.side}: ${o.status}, noch kein Fill`);
      continue;
    }
    let lot = lots.get(symbol);
    if (!lot) {
      const when = String(o.filled_at || o.submitted_at || today()).slice(0, 10);
      lot = { symbol, sleeve: rec.sleeve, qty: 0, cost: 0, entryDate: when };
      lots.set(symbol, lot);
    }
    if (side === "buy") {
      lot.qty += filled;
      lot.cost += filled * avg;
      cash -= filled * avg;
    } else {
      const use = Math.min(filled, lot.qty);
      const basis = lot.qty > 0 ? lot.cost / lot.qty : avg;
      lot.qty -= use;
      lot.cost -= use * basis;
      cash += use * avg;
      if (filled - use > 1e-5) log.push(`${symbol}: Fill-Verkauf ${filled} ist größer als der Bestand`);
    }
  }
  const old = new Map(state.positions.map(p => [p.symbol, p]));
  const next: Position[] = [];
  for (const lot of lots.values()) {
    if (!(lot.qty > 1e-6)) continue;
    const prev = old.get(lot.symbol);
    const entry = lot.cost / lot.qty;
    next.push({
      symbol: lot.symbol,
      sleeve: prev?.sleeve || lot.sleeve,
      qty: lot.qty,
      entry,
      entryDate: prev?.entryDate || lot.entryDate,
      stop: prev?.stop && prev.stop > 0 && prev.stop <= Math.max(prev.peak || 0, entry) ? prev.stop : 0,
      peak: Math.max(prev?.peak ?? 0, entry),
    });
  }
  state.positions = next;
  state.cash = cash;
  log.push(`Buch aus Fills: Cash ${r2(cash)} $, Positionen ${next.length}`);
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
  // Regimefilter: Einzelwerte nur kaufen, wenn der Gesamtmarkt über SMA200 steht.
  const regimeOk = spyClose > spySma;
  for (const s of regimeOk ? picks : []) {
    if (!state.positions.find(p => p.symbol === s))
      d.push({ symbol: s, action: "ABSTAIN", sleeve: "sat",
        reason: "Lehre: Out-of-Sample ab 2022 −12,4 %, Profitfaktor 0,01. Kein neuer Einzelkauf." });
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
  const halted = (state.haltedUntil && state.haltedUntil >= t) || state.ddHalt === true;
  let cash = state.cash;

  for (const d of decisions) {
    if (d.action !== "BUY") { out.push(d); continue; }
    if (halted) { out.push({ ...d, action: "ABSTAIN", reason: `GATE: Käufe gesperrt (${state.ddHalt ? "Drawdown-Erholung abwarten" : "Halt bis " + state.haltedUntil}) – ${d.reason}` }); continue; }
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

  // 2. Bestand nur aus Fills. Eine angenommene Order ändert weder Cash noch Stückzahl.
  // Sonst liegt das Book über dem Broker und der nächste Tag bricht ab.
  await rebuildFromFills(state, log);
  const openOrders: { symbol?: string; side?: string }[] = await alpaca("/orders?status=open&limit=50").catch(() => []);

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
  // Gesamt-Drawdown: Käufe sperren – und wieder freigeben, sobald sich das
  // Book auf die halbe Grenze erholt hat. Verkäufe und Stops laufen weiter.
  if (totalDD >= cfg.totalDrawdownHalt) {
    if (!state.ddHalt) log.push(`🛑 Gesamt-Drawdown ${r2(totalDD * 100)} % → Käufe gesperrt bis zur Erholung`);
    state.ddHalt = true;
  } else if (state.ddHalt && totalDD < cfg.totalDrawdownHalt / 2) {
    state.ddHalt = false;
    log.push(`✅ Erholt auf ${r2(totalDD * 100)} % Drawdown → Käufe wieder frei`);
  }

  // 6. Stops (Trailing ATR) – immer, auch wenn gehalten
  const decisions: Decision[] = [];
  for (const p of state.positions) {
    if (!bars.has(p.symbol)) continue;
    const b = bars.get(p.symbol)!, c = price(p.symbol);
    const pair = BOOK === "hebel" ? HEBEL.pairs.find(x => x.lev === p.symbol) : undefined;
    const stopBase = pair ? bars.get(pair.base) : b;
    if (!stopBase) continue;
    const a = atr(stopBase);
    if (a == null) continue;
    const scale = pair ? c / stopBase[stopBase.length - 1].close * 3 : 1;
    p.peak = Math.max(p.peak || c, c);
    const trail = p.peak - cfg.atrMult * a * scale;
    p.stop = p.stop > 0 ? Math.max(p.stop, trail) : trail;
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

  // 9. Orders schicken, aber erst ein Fill ändert das Book.
  // Was heute rausgeht, wird nicht in derselben Minute wieder gekauft.
  const exitToday = new Set(final.filter(d => d.action === "SELL").map(d => d.symbol));
  for (const d of final) {
    journal({ type: "decision", ...d, equity: r2(equity), cash: r2(state.cash) });
    if (d.action === "BUY" && exitToday.has(d.symbol)) {
      log.push(`${d.symbol} BUY ausgesetzt: heute erst verkauft`);
      journal({ type: "order_skip", symbol: d.symbol, side: "BUY", reason: "Heute verkauft, kein sofortiger Wiedereinstieg" });
      continue;
    }
    if (CHECK_ONLY || d.action === "HOLD" || d.action === "ABSTAIN") { if (d.action !== "HOLD") log.push(`• ${d.symbol} ${d.action}: ${d.reason}`); continue; }
    const side = d.action === "BUY" ? "buy" : "sell";
    if (openOrders.some(o => o.symbol === d.symbol && (o.side ?? "").toLowerCase() === side)) {
      log.push(`${d.symbol} ${d.action}: Order liegt schon, keine zweite`);
      journal({ type: "order_skip", symbol: d.symbol, side: d.action, reason: "Order liegt schon beim Broker" });
      continue;
    }
    let sellQty = d.qty;
    if (side === "sell") {
      const held = broker.find(x => x.symbol === d.symbol)?.qty ?? 0;
      sellQty = Math.min(sellQty ?? 0, held);
      if (!(sellQty > 1e-6)) {
        log.push(`${d.symbol} SELL: Broker hat keine Stücke, keine Order`);
        journal({ type: "order_skip", symbol: d.symbol, side: "SELL", reason: "Broker-Menge ist 0" });
        continue;
      }
    }
    try {
      const o = d.action === "BUY"
        ? await alpacaOrder(d.symbol, "buy", { notional: d.notional })
        : await alpacaOrder(d.symbol, "sell", { qty: sellQty });
      journal({ type: "order", symbol: d.symbol, side: d.action, orderId: o.id, notional: d.notional, qty: d.qty, status: o.status });
      openOrders.push({ symbol: d.symbol, side });
      log.push(`${d.action} ${d.symbol} geschickt (${o.status}). Stand ändert sich erst mit dem Fill.`);
    } catch (e: any) {
      journal({ type: "order_error", symbol: d.symbol, error: e.message });
      log.push(`⚠ Order ${d.symbol} fehlgeschlagen: ${e.message}`);
    }
  }

  await rebuildFromFills(state, log);

  // 10. Equity-Historie + Report. Derselbe Tag wird ersetzt, nicht doppelt geschrieben.
  equity = state.cash + state.positions.reduce((a, p) => a + p.qty * (bars.has(p.symbol) ? price(p.symbol) : p.entry), 0);
  const point = { date: t, equity: r2(equity) };
  const lastPoint = state.equityHistory.at(-1);
  if (lastPoint?.date === t) lastPoint.equity = point.equity;
  else state.equityHistory.push(point);
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
