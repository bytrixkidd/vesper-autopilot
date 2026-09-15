# Vesper Autopilot (Paper only)

Läuft als GitHub-Actions-Cron Mo–Fr nach US-Close. Kein Browser, kein Mac, kein Grok-Abo nötig.
Zwei getrennte Books mit je 300 $ auf demselben Alpaca-Paper-Konto:

- **main** – Core-Satellite: 60 % SPY mit SMA200-Filter, 40 % Momentum-Top-3 (monatlich), ATR-2,5-Trailing-Stop
- **hebel** – Hebel-ETF-Sleeve: TQQQ/SOXL/NVDL/TSLL/UPRO nur bei Basiswert > SMA50 & SMA200, RSI < 70, max 10 Tage, ATR-3-Stop

**Vesper** (Grok über die xAI-API, `src/vesper.ts`) ist die KI-Schicht: Sie sieht Lage, Kauf-Kandidaten, Book-Zustand und die letzten 20 Journal-Einträge (ihr Gedächtnis) und darf jeden Kauf mit CONFIRM oder VETO bewerten plus ein Lagebild schreiben. Sizing, Stops, Verkäufe und Limits bleiben im Code. Fällt Vesper aus → keine Käufe an dem Tag, Verkäufe laufen. `VESPER=off` schaltet auf reines Regelwerk (für den Vergleich).

Im Code existiert nur `https://paper-api.alpaca.markets`. Live gibt es nicht.

## Setup (einmalig)

1. Neues GitHub-Repo (privat), diesen Ordner hochladen.
2. Repo → Settings → Secrets and variables → Actions → *New repository secret*, viermal:
   `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `GROK_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   (Grok-Key: console.x.ai → API Keys. Telegram optional – ohne läuft es, nur ohne Report.)
3. Repo → Settings → Actions → General → *Workflow permissions* → **Read and write** (damit das Journal committet wird).
4. Repo → Actions → *autopilot* → *Run workflow* mit `check = true`. Ergebnis kommt per Telegram und steht im Actions-Log. Es werden keine Orders gesendet.
5. Nochmal *Run workflow* mit `check = false` → erster echter Paper-Lauf. Ab dann täglich automatisch.

## Lokal testen

```
cp .env.example .env   # Keys eintragen
npm install
BOOK=main npx tsx --env-file=.env src/autopilot.ts --check
```

## Dateien

- `src/autopilot.ts` – Daten (Yahoo), Strategie, Risk-Gate, Alpaca-Orders, Journal, Telegram
- `src/vesper.ts` – KI-Schicht (Grok): CONFIRM/VETO je Kauf, Lagebild, Gedächtnis aus dem Journal
- `desk/vesper-feed.ts` – Lese-Anbindung für Vesper Desk; `desk/GROK-PROMPT.md` – Umbau-Anweisung für Grok
- `data/state-<book>.json` – Book-Zustand (Cash, Positionen, Stops, Equity-Verlauf)
- `data/journal-<book>.jsonl` – jede Entscheidung, Order, Ablehnung, Fehler
- `data/blackout.json` – Daten ohne Käufe (FOMC, CPI) – bitte pflegen

## Regeln, die der Code erzwingt

- Fehlen Kurse, ist das Tape älter als 4 Tage, antwortet Alpaca nicht oder stimmt das Book nicht mit dem Broker überein → **ABSTAIN**, kein Trade, Telegram-Warnung.
- Risk-Gate darf Käufe nur ablehnen oder verkleinern, nie vergrößern.
- Tages-Drawdown (main 3 %, hebel 5 %) → Käufe gesperrt. Gesamt-Drawdown (main 15 %, hebel 25 %) → Book stoppt dauerhaft (State-Datei manuell zurücksetzen, um neu zu starten).
- Bracket-Orders unterstützt Alpaca für Fractional Shares nicht → Stops werden im Code geführt und täglich nach Close geprüft.

## Vesper Desk anbinden

`desk/vesper-feed.ts` in den Desk kopieren, Grok den Text aus `desk/GROK-PROMPT.md` geben. Der Desk liest dann Stand, Positionen, Journal und Vespers Lagebild aus dem Repo und zeigt sie an – er entscheidet und handelt nichts mehr. Dafür das Repo **öffentlich** stellen (es enthält keine Keys) oder im Desk einen Fine-grained Token mit "Contents: read" übergeben.

## Nicht enthalten

- Knock-out-Simulation (Sleeve B) – nächster Schritt, gleicher Aufbau wie `strategyHebel`.
- Backtest – `src/backtest.ts` folgt; bis dahin gilt das Hauptbook als unbewiesen.
