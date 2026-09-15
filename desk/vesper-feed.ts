/**
 * Vesper Desk – Anbindung an den Motor (GitHub-Repo).
 * Browser-kompatibel, keine Abhängigkeiten. In den Desk kopieren.
 *
 * Der Desk liest NUR. Er entscheidet und handelt nichts mehr.
 *
 * Voraussetzung: Repo öffentlich (empfohlen – es enthält keine Keys),
 * ODER ein Fine-grained Token mit "Contents: read" als `token` übergeben
 * (dann liegt der Token im Browser – nur für den eigenen Desk vertretbar).
 */

export type BookState = {
  book: string; startCapital: number; cash: number;
  positions: { symbol: string; sleeve: string; qty: number; entry: number; entryDate: string; stop: number; peak: number }[];
  equityHistory: { date: string; equity: number }[]; peakEquity: number;
  haltedUntil: string | null; lastRebalanceMonth: string | null; lastRun: string | null;
};

export type JournalEntry = { ts: string; book: string; type: string; [k: string]: unknown };

export type BookFeed = {
  state: BookState;
  journal: JournalEntry[];
  latestVesper: { ts: string; outlook: string; verdicts: unknown[] } | null;
  todayDecisions: JournalEntry[];
  equity: number;
  returnPct: number;
  drawdownPct: number;
  lastRunAgeHours: number | null;
  alive: boolean; // false, wenn > 30 h kein Lauf → im Desk rot anzeigen
};

export async function fetchBook(opts: {
  owner: string; repo: string; book: "main" | "hebel"; branch?: string; token?: string;
}): Promise<BookFeed> {
  const branch = opts.branch ?? "main";
  const base = `https://raw.githubusercontent.com/${opts.owner}/${opts.repo}/${branch}/data`;
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  const bust = `?t=${Date.now()}`;

  const [stateRes, journalRes] = await Promise.all([
    fetch(`${base}/state-${opts.book}.json${bust}`, { headers }),
    fetch(`${base}/journal-${opts.book}.jsonl${bust}`, { headers }),
  ]);
  if (!stateRes.ok) throw new Error(`state-${opts.book}.json: HTTP ${stateRes.status}`);
  const state: BookState = await stateRes.json();
  const journal: JournalEntry[] = journalRes.ok
    ? (await journalRes.text()).trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];

  const equity = state.equityHistory.at(-1)?.equity ?? state.cash;
  const today = new Date().toISOString().slice(0, 10);
  const vesper = [...journal].reverse().find(j => j.type === "vesper") as BookFeed["latestVesper"] | undefined;
  const lastRunAgeHours = state.lastRun ? (Date.now() - new Date(state.lastRun).getTime()) / 3_600_000 : null;

  return {
    state, journal,
    latestVesper: vesper ?? null,
    todayDecisions: journal.filter(j => j.type === "decision" && j.ts.startsWith(today)),
    equity,
    returnPct: (equity / state.startCapital - 1) * 100,
    drawdownPct: (1 - equity / state.peakEquity) * 100,
    lastRunAgeHours,
    alive: lastRunAgeHours !== null && lastRunAgeHours < 30,
  };
}

/** Beide Books auf einmal, für die Demo-Seite. */
export async function fetchAllBooks(opts: { owner: string; repo: string; branch?: string; token?: string }) {
  const [main, hebel] = await Promise.allSettled([
    fetchBook({ ...opts, book: "main" }),
    fetchBook({ ...opts, book: "hebel" }),
  ]);
  return {
    main: main.status === "fulfilled" ? main.value : null,
    hebel: hebel.status === "fulfilled" ? hebel.value : null,
  };
}
