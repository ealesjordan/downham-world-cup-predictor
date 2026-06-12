# Downham Town FC — World Cup 2026 Predictor & Leaderboard

**Live site: https://ealesjordan.github.io/downham-world-cup-predictor/**

A single-page predictor (`index.html`) plus an auto-updating leaderboard driven by a
daily GitHub Action that pulls real results from API-Football.

## Files

| File | What it is |
|------|------------|
| `index.html` | The app: predictions, WhatsApp export, and the Leaderboard view. |
| `predictions.json` | Everyone's entries (the "seed"). An array of entry objects. |
| `results.json` | Actual results, written by the GitHub Action. Don't hand-edit. |
| `scripts/fetch-results.mjs` | Fetches results from ESPN's free public API and writes `results.json`. |
| `.github/workflows/update-results.yml` | Runs the script every 2 hours + on manual trigger. |

## One-time setup

1. **Create the repo** and add all of these files at the paths shown above (keep the
   folder structure: `scripts/…` and `.github/workflows/…`).
2. **Turn on GitHub Pages**: Settings → Pages → deploy from `main`, root. You'll get a
   link like `https://<you>.github.io/<repo>/` — that's what you share.
3. **No API key needed.** Results come from ESPN's free public scoreboard API
   (`site.api.espn.com/.../soccer/fifa.world/scoreboard`) — no registration, no secret.
4. **Enable Actions** if prompted, then open the **Actions** tab → "Update World Cup
   results" → **Run workflow** to do the first fetch. After that it runs every 2 hours.

## How predictions get in

Everyone fills in the app and sends you their WhatsApp message. Those go into
`predictions.json` as an array of entries. The shape of each entry matches exactly what
the app stores:

```json
{
  "name": "Jordan E",
  "category": "Adult",
  "winner": "England",
  "topScorer": "Harry Kane",
  "predictions": { "A-1-0": { "h": "2", "a": "1" } },
  "knockout": { "73": "Switzerland", "103": "England" }
}
```

`predictions` is keyed by internal match IDs (`<group>-<matchday>-<index>`) and `knockout`
by match number (73–88 = R32, … 103 = Final). The included `predictions.json` has one
sample entry — replace it with the real ones. *(I can build a paste-the-WhatsApp-message
→ JSON importer next so you don't assemble this by hand.)*

## How scoring works

All scoring happens in the browser from `predictions.json` + `results.json` — one source
of truth, instantly correct whenever results update. Points are configurable at the top
of the leaderboard code in `index.html`:

```js
var SCORING = {
  exact: 5, result: 2,          // group score: exact / right result
  qualifier: 10,                // each correct Round-of-32 team
  winner: 25, topScorer: 25,    // pre-tournament picks
  koPerCorrect: 2               // each correct knockout-round winner (same as a correct group result)
};
```

Knockout picks are winner selections (who advances), so they score like a correct group
result — **2 points** per correct pick, every round. Change any of these values to whatever
you agree.

## Things to check once it's live

- **Team-name mapping.** The fetch script maps API team names to the ones used in the app
  (e.g. "Czech Republic" → "Czechia", "Korea Republic" → "South Korea"). If the Action log
  prints `⚠ Unmapped team names: …`, add those to the `ALIASES` map in
  `scripts/fetch-results.mjs`. This is the most likely thing to need a tweak.
- **Knockout winners** are scored on who actually advanced (including extra time/penalties).
- **Top scorer** isn't currently fetched — ESPN's scoreboard endpoint doesn't carry
  tournament top-scorer stats, so `topScorers` is left empty (and any value you set by hand
  in `results.json` is preserved across runs). It can be wired up later via ESPN's core API.

## Cadence

The workflow runs every 2 hours and on demand (Actions → Run workflow). Adjust the `cron`
line in the workflow to refresh more or less often (e.g. `- cron: "0 6 * * *"` for daily
once the tournament is over).
