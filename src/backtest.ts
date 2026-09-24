/**
 * Vesper Backtest – dieselben Regeln wie der Autopilot, auf historischen Tageskerzen.
 *
 * Aufruf:  BOOK=main npx tsx src/backtest.ts       (oder BOOK=hebel)
 *
 * Grundsätze:
 *  - Entscheidung nach Schluss von Tag t, Ausführung zur Eröffnung von Tag t+1.
 *    Kein Look-ahead: an Tag t werden nur Kerzen bis einschließlich t benutzt.
 *  - Kosten: 0,05 % Slippage je Seite (Alpaca nimmt keine Kommission).
 *  - Walk-forward: Parameter wurden auf 2016–2021 gewählt; 2022–heute ist
 *    unberührter Testzeitraum. Beide Abschnitte werden getrennt ausgewiesen.
 *  - Vesper (LLM) ist hier NICHT beteiligt – ein LLM lässt sich nicht
 *    rückwirkend befragen, ohne die Zukunft zu kennen. Gemessen wird das
 *    Regelwerk, auf dem Vesper aufsetzt.
 */

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";
const BOOK = (process.env.BOOK ?? "main") as "main" | "hebel";
const SLIPPAGE = 0.0005;
const START_CAPITAL = 300;

const MAIN = {
  coreSymbol: "SPY", coreShare: 0.6, coreSma: 200,
  satShare: 0.4,
  satUniverse: ["META","AAPL","MSFT","NVDA","GOOGL","AMZN","AVGO","JPM","BLK","TSLA",
                "LLY","V","MA","COST","NFLX","AMD","UNH","XOM","HD","PG"],
  satTop: 3, satMomentumDays: 126, satSma: 100,
  atrMult: 2.5, maxPositionPct: 0.20,
  dailyDrawdownHalt: 0.03, totalDrawdownHalt: 0.15,
};

const HEBEL = {
  pairs: [
    { lev: "TQQQ", base: "QQQ"  },
    { lev: "SOXL", base: "SOXX" },
    { lev: "NVDL", base: "NVDA" },
    { lev: "TSLL", base: "TSLA" },
    { lev: "UPRO", base: "SPY"  },
  ],
  sma1: 50, sma2: 200, rsiMax: 70,
  maxPositionPct: 0.15, maxPositions: 3, maxHoldDays: 10,
  atrMult: 3.0, dailyDrawdownHalt: 0.05, totalDrawdownHalt: 0.25,
};

type Bar = { date: string; open: number; high: number; low: number; close: number };
type Pos = { symbol: string; sleeve: string; qty: number; entry: number; entryIdx: number; stop: number; peak: number };
type Trade = { symbol: string; entryDate: string; exitDate: string; pnl: number; pct: number; reason: string };

const r2 = (n: number) => Math.round(n * 100) / 100;

async function bars(symbol: string): Promise<Bar[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${YAHOO}/${symbol}?range=10y&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      const r = j?.chart?.result?.[0];
      if (!r) throw new Error("keine Daten");
      const q = r.indicators.quote[0];
      const out: Bar[] = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null)) continue;
        out.push({ date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
          open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
      }
      return out;
    } catch (e) {
      if (attempt === 2) { console.error(`  ${symbol}: ${e}`); return []; }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return [];
}

// Indikatoren auf bars[0..i] (einschließlich i)
function smaAt(b: Bar[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let s = 0; for (let k = i - n + 1; k <= i; k++) s += b[k].close;
  return s / n;
}
function atrAt(b: Bar[], i: number, n = 14): number | null {
  if (i < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++)
    s += Math.max(b[k].high - b[k].low, Math.abs(b[k].high - b[k-1].close), Math.abs(b[k].low - b[k-1].close));
  return s / n;
}
function rsiAt(b: Bar[], i: number, n = 14): number | null {
  if (i < n) return null;
  let g = 0, l = 0;
  for (let k = i - n + 1; k <= i; k++) { const d = b[k].close - b[k-1].close; if (d > 0) g += d; else l -= d; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function momAt(b: Bar[], i: number, n: number): number | null {
  if (i < n) return null;
  return b[i].close / b[i - n].close - 1;
}

function metrics(equity: { date: string; v: number }[], trades: Trade[], bench: { date: string; v: number }[]) {
  if (equity.length < 2) return null;
  const first = equity[0].v, last = equity.at(-1)!.v;
  const years = (new Date(equity.at(-1)!.date).getTime() - new Date(equity[0].date).getTime()) / (365.25 * 86400_000);
  const rets: number[] = [];
  let peak = first, maxDD = 0;
  for (let i = 1; i < equity.length; i++) {
    rets.push(equity[i].v / equity[i-1].v - 1);
    peak = Math.max(peak, equity[i].v);
    maxDD = Math.max(maxDD, 1 - equity[i].v / peak);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  let benchDD = 0, bp = bench[0]?.v ?? 0;
  for (const b of bench) { bp = Math.max(bp, b.v); benchDD = Math.max(benchDD, 1 - b.v / bp); }
  return {
    von: equity[0].date, bis: equity.at(-1)!.date,
    start: r2(first), ende: r2(last),
    renditePct: r2((last / first - 1) * 100),
    cagrPct: r2(((last / first) ** (1 / Math.max(years, 0.1)) - 1) * 100),
    maxDrawdownPct: r2(maxDD * 100),
    sharpe: r2(sharpe),
    profitfaktor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    trades: trades.length,
    trefferquotePct: trades.length ? r2(wins.length / trades.length * 100) : null,
    benchmarkSPY: { renditePct: bench.length ? r2((bench.at(-1)!.v / bench[0].v - 1) * 100) : null,
                    maxDrawdownPct: r2(benchDD * 100) },
  };
}

async function run() {
  console.log(`Backtest Book "${BOOK}" – lade Kurse …`);
  const cfg = BOOK === "main" ? MAIN : HEBEL;
  const symbols = BOOK === "main"
    ? [MAIN.coreSymbol, ...MAIN.satUniverse]
    : [...new Set(HEBEL.pairs.flatMap(p => [p.lev, p.base]))];
  if (BOOK === "hebel" && !symbols.includes("SPY")) symbols.push("SPY");

  const data = new Map<string, Bar[]>();
  for (const s of symbols) {
    const b = await bars(s);
    if (b.length) data.set(s, b);
    await new Promise(r => setTimeout(r, 250));
  }
  const spy = data.get("SPY");
  if (!spy) throw new Error("SPY-Kurse fehlen – Backtest nicht möglich");

  // Gemeinsamer Handelskalender = SPY-Tage; Index je Symbol über Datum
  const idx = new Map<string, Map<string, number>>();
  for (const [s, b] of data) idx.set(s, new Map(b.map((x, i) => [x.date, i])));
  const at = (s: string, date: string) => {
    const i = idx.get(s)?.get(date);
    return i === undefined ? null : { b: data.get(s)!, i };
  };

  let cash = START_CAPITAL;
  let positions: Pos[] = [];
  const trades: Trade[] = [];
  const equity: { date: string; v: number }[] = [];
  const benchmark: { date: string; v: number }[] = [];
  let peakEq = START_CAPITAL, haltUntil = -1, lastRebalanceMonth = "";
  let ddHalt = false; // Gesamt-Drawdown-Sperre: atmet, statt dauerhaft abzuschalten
  let benchQty = 0;
  const startIdx = spy.findIndex(b => b.date >= "2016-01-04");
  let pending: { symbol: string; sleeve: string; side: "buy" | "sell"; notional?: number; qty?: number; reason: string }[] = [];

  for (let d = Math.max(startIdx, 210); d < spy.length; d++) {
    const date = spy[d].date;

    // Ausführung der gestern beschlossenen Orders zur heutigen Eröffnung
    for (const o of pending) {
      const h = at(o.symbol, date); if (!h) continue;
      const px = h.b[h.i].open * (o.side === "buy" ? 1 + SLIPPAGE : 1 - SLIPPAGE);
      if (o.side === "buy") {
        const notional = Math.min(o.notional!, cash);
        if (notional < 1) continue;
        const a = atrAt(h.b, h.i, 14) ?? px * 0.02;
        positions.push({ symbol: o.symbol, sleeve: o.sleeve, qty: notional / px, entry: px, entryIdx: d,
          stop: px - cfg.atrMult * a, peak: px });
        cash -= notional;
      } else {
        const p = positions.find(x => x.symbol === o.symbol); if (!p) continue;
        const proceeds = p.qty * px;
        cash += proceeds;
        trades.push({ symbol: p.symbol, entryDate: spy[p.entryIdx].date, exitDate: date,
          pnl: proceeds - p.qty * p.entry, pct: (px / p.entry - 1) * 100, reason: o.reason });
        positions = positions.filter(x => x.symbol !== o.symbol);
      }
    }
    pending = [];

    // Benchmark: SPY buy & hold ab erstem Tag
    if (benchQty === 0) benchQty = START_CAPITAL / spy[d].open;
    benchmark.push({ date, v: benchQty * spy[d].close });

    // Bewertung zum heutigen Schluss
    const mark = (p: Pos) => { const h = at(p.symbol, date); return h ? h.b[h.i].close : p.entry; };
    const eq = cash + positions.reduce((a, p) => a + p.qty * mark(p), 0);
    const prevEq = equity.at(-1)?.v ?? START_CAPITAL;
    equity.push({ date, v: eq });
    peakEq = Math.max(peakEq, eq);
    const dayChange = eq / prevEq - 1;
    const totalDD = 1 - eq / peakEq;

    if (-dayChange >= cfg.dailyDrawdownHalt) haltUntil = d + (BOOK === "hebel" ? 2 : 1);
    // Gesamt-Drawdown: Käufe sperren, sobald die Grenze gerissen ist –
    // und wieder freigeben, sobald sich das Book auf die halbe Grenze erholt hat.
    if (totalDD >= cfg.totalDrawdownHalt) ddHalt = true;
    else if (ddHalt && totalDD < cfg.totalDrawdownHalt / 2) ddHalt = false;
    const halted = d < haltUntil || ddHalt;

    // Stops (Trailing, auf Schlusskurs geprüft)
    for (const p of [...positions]) {
      const h = at(p.symbol, date); if (!h) continue;
      const c = h.b[h.i].close;
      const stopSrc = BOOK === "hebel"
        ? at(HEBEL.pairs.find(x => x.lev === p.symbol)!.base, date) : h;
      const a = stopSrc ? (atrAt(stopSrc.b, stopSrc.i, 14) ?? c * 0.02) : c * 0.02;
      const scale = BOOK === "hebel" && stopSrc ? (c / stopSrc.b[stopSrc.i].close) * 3 : 1;
      p.peak = Math.max(p.peak, c);
      p.stop = Math.max(p.stop, p.peak - cfg.atrMult * a * scale);
      if (c <= p.stop) pending.push({ symbol: p.symbol, sleeve: p.sleeve, side: "sell", reason: "Stop" });
    }

    // Strategie
    if (BOOK === "main") {
      const sma200 = smaAt(spy, d, MAIN.coreSma);
      const corePos = positions.find(p => p.symbol === MAIN.coreSymbol);
      if (sma200 !== null) {
        if (spy[d].close > sma200 && !corePos && !halted && !pending.some(o => o.symbol === "SPY"))
          pending.push({ symbol: "SPY", sleeve: "core", side: "buy", notional: Math.min(eq * MAIN.coreShare, eq * MAIN.maxPositionPct, cash), reason: "SPY > SMA200" });
        else if (spy[d].close <= sma200 && corePos && !pending.some(o => o.symbol === "SPY"))
          pending.push({ symbol: "SPY", sleeve: "core", side: "sell", reason: "SPY < SMA200" });
      }

      const mth = date.slice(0, 7);
      const isLastTradingDayOfMonth = d + 1 < spy.length && spy[d + 1].date.slice(0, 7) !== mth;
      if (isLastTradingDayOfMonth && mth !== lastRebalanceMonth) {
        lastRebalanceMonth = mth;
        const ranked = MAIN.satUniverse.map(s => {
          const h = at(s, date); if (!h) return null;
          const m = momAt(h.b, h.i, MAIN.satMomentumDays), sm = smaAt(h.b, h.i, MAIN.satSma);
          if (m === null || sm === null) return null;
          return { s, m, above: h.b[h.i].close > sm };
        }).filter(Boolean).sort((a, b) => b!.m - a!.m) as { s: string; m: number; above: boolean }[];
        const picks = ranked.slice(0, MAIN.satTop).filter(x => x.above).map(x => x.s);
        for (const p of positions.filter(p => p.sleeve === "sat"))
          if (!picks.includes(p.symbol)) pending.push({ symbol: p.symbol, sleeve: "sat", side: "sell", reason: "Rebalance" });
        // Regimefilter: Einzelwerte nur kaufen, wenn der Gesamtmarkt über SMA200 steht.
        const regimeOk = sma200 !== null && spy[d].close > sma200;
        if (!halted && regimeOk) {
          const per = (eq * MAIN.satShare) / MAIN.satTop;
          for (const s of picks)
            if (!positions.find(p => p.symbol === s))
              pending.push({ symbol: s, sleeve: "sat", side: "buy", notional: Math.min(per, eq * MAIN.maxPositionPct), reason: "Momentum Top-3" });
        }
      }
    } else {
      let open = positions.length;
      for (const { lev, base } of HEBEL.pairs) {
        const hb = at(base, date), hl = at(lev, date);
        if (!hb || !hl) continue;
        const c = hb.b[hb.i].close;
        const s1 = smaAt(hb.b, hb.i, HEBEL.sma1), s2 = smaAt(hb.b, hb.i, HEBEL.sma2), rs = rsiAt(hb.b, hb.i);
        if (s1 === null || s2 === null || rs === null) continue;
        const trendOk = c > s1 && c > s2;
        const pos = positions.find(p => p.symbol === lev);
        if (pos) {
          if (pending.some(o => o.symbol === lev)) continue;
          if (!trendOk) pending.push({ symbol: lev, sleeve: "hebel", side: "sell", reason: "Trendbruch" });
          else if (d - pos.entryIdx >= HEBEL.maxHoldDays) pending.push({ symbol: lev, sleeve: "hebel", side: "sell", reason: "Haltedauer" });
        } else if (trendOk && rs < HEBEL.rsiMax && open < HEBEL.maxPositions && !halted) {
          pending.push({ symbol: lev, sleeve: "hebel", side: "buy", notional: Math.min(eq * HEBEL.maxPositionPct, cash), reason: "Trend + RSI" });
          open++;
        }
      }
    }
  }

  // Auswertung, gesamt und walk-forward getrennt
  const split = (from: string, to: string) => {
    const e = equity.filter(x => x.date >= from && x.date <= to);
    const b = benchmark.filter(x => x.date >= from && x.date <= to);
    const t = trades.filter(x => x.exitDate >= from && x.exitDate <= to);
    return e.length > 2 ? metrics(e, t, b) : null;
  };

  const result = {
    book: BOOK,
    erstellt: new Date().toISOString(),
    hinweis: "Regelwerk ohne Vesper/LLM. Ausführung zur Eröffnung des Folgetages, 0,05 % Slippage.",
    gesamt: metrics(equity, trades, benchmark),
    insample_2016_2021: split("2016-01-01", "2021-12-31"),
    outofsample_ab_2022: split("2022-01-01", "2099-12-31"),
    schlechtesteTrades: [...trades].sort((a, b) => a.pct - b.pct).slice(0, 5).map(t => ({ ...t, pnl: r2(t.pnl), pct: r2(t.pct) })),
    equityKurve: equity.filter((_, i) => i % 5 === 0).map(x => ({ d: x.date, v: r2(x.v) })),
  };

  const fs = await import("node:fs");
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(`data/backtest-${BOOK}.json`, JSON.stringify(result, null, 2));

  const fmt = (m: any, label: string) => m
    ? `\n${label}\n  ${m.von} bis ${m.bis}\n  Rendite ${m.renditePct} %   CAGR ${m.cagrPct} %   MaxDD ${m.maxDrawdownPct} %\n  Sharpe ${m.sharpe}   Profitfaktor ${m.profitfaktor}   Trades ${m.trades}   Treffer ${m.trefferquotePct} %\n  SPY Buy&Hold: ${m.benchmarkSPY.renditePct} %   MaxDD ${m.benchmarkSPY.maxDrawdownPct} %`
    : `\n${label}\n  (keine Daten)`;

  console.log(fmt(result.gesamt, "GESAMT"));
  console.log(fmt(result.insample_2016_2021, "IN-SAMPLE 2016-2021 (Parameter hier gewaehlt)"));
  console.log(fmt(result.outofsample_ab_2022, "OUT-OF-SAMPLE ab 2022 (der ehrliche Test)"));
  console.log(`\ndata/backtest-${BOOK}.json geschrieben.`);
}

run().catch(e => { console.error("Backtest fehlgeschlagen:", e.message); process.exit(1); });
