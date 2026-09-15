/**
 * Vesper – die KI-Schicht des Motors.
 *
 * Prinzip: Vesper schlägt vor, Code entscheidet.
 *  - Vesper sieht: Lage je Symbol, Kandidaten-Entscheidungen des Regelwerks,
 *    die letzten Journal-Einträge (ihr Gedächtnis) und den Book-Zustand.
 *  - Vesper darf: einen KAUF bestätigen (CONFIRM) oder ablehnen (VETO),
 *    eine Confidence geben, eine Begründung schreiben, ein Lagebild liefern.
 *  - Vesper darf nicht: Positionsgröße, Stops, Verkäufe oder Limits anfassen.
 *  - Fällt Vesper aus (Timeout, kaputtes JSON): alle Käufe → ABSTAIN. Verkäufe laufen.
 *
 * API: xAI, OpenAI-kompatibel. Modell per ENV GROK_MODEL (Standard grok-4.6).
 */

const XAI = "https://api.x.ai/v1/chat/completions";

export type MarketRow = {
  symbol: string; close: number; sma50: number | null; sma200: number | null;
  mom126: number | null; rsi14: number | null; atr14: number | null; dayChange: number;
};

export type Candidate = { symbol: string; action: string; sleeve: string; reason: string; notional?: number };

export type Verdict = { symbol: string; verdict: "CONFIRM" | "VETO"; confidence: number; reason: string };

export type VesperResult = { verdicts: Verdict[]; outlook: string; raw: string };

const SYSTEM = `Du bist Vesper, die KI-Analystin eines kleinen Paper-Trading-Books (300 $ Start, nur Papiergeld, US-Aktien/ETF, Tagesschluss).
Du arbeitest mit einem deterministischen Regelwerk zusammen. Das Regelwerk hat Kauf-Kandidaten erzeugt. Deine Aufgabe:
1. Jeden Kauf-Kandidaten prüfen und mit CONFIRM oder VETO bewerten. VETO nur mit konkretem Grund aus den Daten (Überkauft, Ausreißer nach oben ohne Volumen-Bestätigung, Trendbruch im Basiswert, Widerspruch zu deinem Gedächtnis, Ereignisrisiko).
2. Confidence 0–1 angeben.
3. Ein Lagebild in max. 2 Sätzen auf Deutsch, nüchtern, ohne Floskeln.

Regeln:
- Du erfindest keine Kurse, Nachrichten oder Ereignisse. Nur die gelieferten Daten und dein Journal-Gedächtnis zählen.
- Du kannst Käufe nur ablehnen oder bestätigen, nie neue vorschlagen, nie Verkäufe verhindern, nie Größen ändern.
- Wenn du unsicher bist: CONFIRM mit niedriger Confidence, das Regelwerk hat den Backtest, nicht du.
- Lerne aus dem Journal: Wenn ein früheres VETO Geld gespart oder gekostet hat, sag es im Lagebild.

Antworte NUR mit JSON, ohne Markdown:
{"verdicts":[{"symbol":"…","verdict":"CONFIRM|VETO","confidence":0.0,"reason":"…"}],"outlook":"…"}`;

export async function askVesper(input: {
  book: string; date: string; equity: number; cash: number; drawdownPct: number;
  market: MarketRow[]; candidates: Candidate[]; memory: unknown[];
}): Promise<VesperResult> {
  const key = process.env.GROK_API_KEY;
  if (!key) throw new Error("GROK_API_KEY fehlt");
  const model = process.env.GROK_MODEL ?? "grok-4.6";

  const user = JSON.stringify({
    book: input.book, date: input.date,
    stand: { equity: input.equity, cash: input.cash, drawdownPct: input.drawdownPct },
    markt: input.market,
    kaufKandidaten: input.candidates.filter(c => c.action === "BUY"),
    andereEntscheidungen: input.candidates.filter(c => c.action !== "BUY").map(c => `${c.symbol} ${c.action}: ${c.reason}`),
    gedaechtnis_letzte_journal_eintraege: input.memory,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(XAI, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`xAI HTTP ${res.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    const content: string = j?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content.replace(/^```json|```$/g, "").trim());
    if (!Array.isArray(parsed.verdicts)) throw new Error("Vesper: verdicts fehlt");
    const verdicts: Verdict[] = parsed.verdicts.map((v: any) => ({
      symbol: String(v.symbol), verdict: v.verdict === "VETO" ? "VETO" : "CONFIRM",
      confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)), reason: String(v.reason ?? "").slice(0, 300),
    }));
    return { verdicts, outlook: String(parsed.outlook ?? "").slice(0, 400), raw: content };
  } finally {
    clearTimeout(timer);
  }
}
