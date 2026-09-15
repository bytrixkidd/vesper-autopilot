# Prompt für Grok – Vesper Desk an den Motor anbinden

Kopiere `desk/vesper-feed.ts` in den Desk und gib Grok diesen Text:

---

Der Autopilot läuft ab jetzt extern: GitHub-Actions-Cron auf Alpaca Paper, zwei Books (`main`, `hebel`), Vesper als KI-Schicht darin (bestätigt oder verwirft Käufe, schreibt Lagebild ins Journal). Der Desk trifft KEINE Entscheidungen mehr und schickt KEINE Orders – nicht Yahoo-Simulation, nicht Alpaca. Entferne oder deaktiviere im Desk jede Kauf-/Verkaufslogik und den Autopilot-Tick. Das alte Yahoo-Book bleibt als Archiv sichtbar, aber eingefroren.

Neue Datenquelle: `desk/vesper-feed.ts` (liegt im Projekt). `fetchAllBooks({ owner: "<GITHUB-USER>", repo: "<REPO>" })` liefert pro Book: Stand, Rendite, Drawdown, Positionen mit Stops, Equity-Verlauf, heutige Entscheidungen, letztes Vesper-Lagebild, `alive`-Flag.

Baue die Demo-Seite so um:
1. Kopf: Einsatz / Stand / Gewinn / Cash pro Book aus dem Feed. Zwei Tabs: main, hebel.
2. "Paper gegen den Markt": Equity-Verlauf aus `state.equityHistory` gegen SPY (SPY-Kurve wie bisher aus Yahoo).
3. Positionen: aus `state.positions`, Spalten Ticker, Sleeve, Stück, Einstieg, Stop, aktueller Wert.
4. "Tägliche Meetings": die `decision`-Einträge des Tages aus dem Journal, mit `reason` als Text. Vesper-VETOs rot, CONFIRMs grün, ABSTAIN amber.
5. Neuer Block "Vesper": `latestVesper.outlook` als Lagebild, darunter die Verdicts.
6. Statuszeile oben rechts: `alive` grün = letzter Lauf < 30 h, rot = Motor steht. Kein "Autopilot 24/7"-Tick mehr, stattdessen "Letzter Lauf: <Zeit>".
7. Der Vesper-Chat im Desk bekommt als Kontext den Feed (Stand, Positionen, letzte 20 Journal-Einträge), damit "Was macht der 300-Dollar-Test gerade?" aus echten Daten antwortet.

Kein Alpaca-Key, kein Grok-Key im Desk. Alle Zahlen kommen aus dem Feed; nichts wird lokal simuliert. Kompletter Code, keine Platzhalter.
