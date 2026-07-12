// fetch-results.mjs — pulls 2026 World Cup results from ESPN's public scoreboard API
// and writes results.json. Run by GitHub Actions.
//
// No API key required. ESPN's site API is undocumented/unofficial but free and updates
// live during matches. We read the FIFA World Cup league (`fifa.world`) one date at a
// time, from the tournament start up to "today" (UTC), and fold every event into the
// same results.json shape the leaderboard in index.html already understands.
//
// Node 20+ (uses global fetch). No external dependencies.

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const OUT = "results.json";

// Tournament window (UTC). We only ever query up to today, so the upper bound just caps
// how far the date loop can run; future days return no finished games anyway.
const START_DATE = "2026-06-11"; // opening match
const END_DATE = "2026-07-19"; // final

// ESPN occasionally 403s requests without a browser-ish User-Agent.
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; downham-world-cup-predictor/1.0)" };

async function api(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error("API " + url + " -> " + res.status);
  return res.json();
}

// ---- Team-name normalisation: map ESPN names to the names used in index.html ----
function norm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}
// Our canonical team names (must match GROUPS in index.html)
const OURS = ["Mexico","South Africa","South Korea","Czechia","Canada","Bosnia & Herzegovina","Qatar","Switzerland","Brazil","Morocco","Haiti","Scotland","USA","Paraguay","Turkey","Australia","Germany","Curaçao","Ivory Coast","Ecuador","Netherlands","Japan","Sweden","Tunisia","Belgium","Egypt","Iran","New Zealand","Spain","Cabo Verde","Saudi Arabia","Uruguay","France","Senegal","Iraq","Norway","Argentina","Algeria","Austria","Jordan","Portugal","DR Congo","Uzbekistan","Colombia","England","Croatia","Ghana","Panama"];
const BY_NORM = {}; OURS.forEach(t => { BY_NORM[norm(t)] = t; });
// Aliases: normalised provider spelling -> our canonical name
const ALIASES = {
  "korearepublic":"South Korea", "republicofkorea":"South Korea",
  "czechrepublic":"Czechia",
  "bosniaandherzegovina":"Bosnia & Herzegovina", "bosniaherzegovina":"Bosnia & Herzegovina",
  "unitedstates":"USA", "unitedstatesofamerica":"USA", "usmnt":"USA", "usa":"USA",
  "turkiye":"Turkey",
  "cotedivoire":"Ivory Coast", "ivorycoast":"Ivory Coast",
  "iriran":"Iran",
  "capeverde":"Cabo Verde", "caboverde":"Cabo Verde", "capeverdeislands":"Cabo Verde",
  "congodr":"DR Congo", "drcongo":"DR Congo", "democraticrepublicofcongo":"DR Congo", "drcongocongo":"DR Congo",
  "curacao":"Curaçao"
};
const unmapped = new Set();
function team(name) {
  const n = norm(name);
  if (BY_NORM[n]) return BY_NORM[n];
  if (ALIASES[n]) return ALIASES[n];
  // Ignore ESPN's bracket placeholders for not-yet-drawn rounds
  // (e.g. "Round of 32 1 Winner", "Semifinal 2 Loser") — not real teams.
  if (!/winner|loser|^roundof|quarterfinal|semifinal|thirdplace|tbd|tobedetermined/.test(n)) unmapped.add(name);
  return name; // fall through (won't match predictions — surfaces in logs)
}

// ---- Round detection ---------------------------------------------------------
// Primary signal: ESPN puts a round/group label in the event/competition text
// (e.g. "Group A", "Round of 32", "Quarterfinals", "Final"). Fall back to the
// published 2026 calendar by date if no usable label is present.
function roundBucketFromText(text) {
  const r = String(text || "").toLowerCase();
  if (r.includes("group")) return "GROUP";
  if (r.includes("round of 32")) return "R32";
  if (r.includes("round of 16")) return "R16";
  if (r.includes("quarter")) return "QF";
  if (r.includes("semi")) return "SF";
  if (r.includes("3rd") || r.includes("third")) return "3P";
  if (r.includes("final")) return "F";
  return null;
}
function roundBucketFromDate(iso) {
  const d = iso.slice(0, 10); // YYYY-MM-DD (event date is UTC ISO)
  // Boundaries are padded a day past each round's last US matchday: late US-night
  // kickoffs roll into the next UTC day (e.g. a 9:30pm CT July-3 R32 game is
  // ~02:30 UTC July 4). Rest days between rounds keep the windows from colliding.
  if (d <= "2026-06-27") return "GROUP";
  if (d <= "2026-07-04") return "R32";  // R32: Jun 28 – Jul 3 US
  if (d <= "2026-07-08") return "R16";  // R16: Jul 5 – Jul 7 US
  if (d <= "2026-07-12") return "QF";   // QF:  Jul 9 – Jul 11 US
  if (d <= "2026-07-16") return "SF";   // SF:  Jul 14 – Jul 15 US
  if (d <= "2026-07-19") return "3P";   // 3rd place: Jul 18 US
  return "F";                           // Final: Jul 19 US (Final/3rd also split by text)
}
function bucketFor(ev, comp) {
  const text = [
    ev && ev.name,
    ...((comp && comp.notes) || []).map(n => n && n.headline),
    comp && comp.type && comp.type.text,
    ev && ev.season && ev.season.slug
  ].filter(Boolean).join(" | ");
  return roundBucketFromText(text) || roundBucketFromDate((ev && ev.date) || "");
}

function eachUTCDate(start, end, cb) {
  const day = 86400000;
  let t = Date.parse(start + "T00:00:00Z");
  // Scan the whole tournament window (not just up to today) so SCHEDULED
  // knockout fixtures are captured as soon as the draw is known — that's what
  // drives the correct knockout ties in the app. Future dates with no games
  // simply return nothing.
  const last = Date.parse(end + "T00:00:00Z");
  for (; t <= last; t += day) {
    const dt = new Date(t);
    const ymd = dt.getUTCFullYear() +
      String(dt.getUTCMonth() + 1).padStart(2, "0") +
      String(dt.getUTCDate()).padStart(2, "0");
    cb(ymd);
  }
}

async function fetchEvents() {
  const dates = [];
  eachUTCDate(START_DATE, END_DATE, d => dates.push(d));
  const byId = new Map();
  for (const d of dates) {
    let j;
    try {
      j = await api(`${BASE}?dates=${d}`);
    } catch (e) {
      console.error(`fetch ${d} failed: ${e.message}`);
      continue;
    }
    for (const ev of (j.events || [])) {
      if (ev && ev.id != null) byId.set(String(ev.id), ev);
    }
  }
  return Array.from(byId.values());
}

// Score after 90 minutes (regulation only). ESPN exposes per-period goals in
// `linescores`; summing the first two periods gives the 90' score and excludes
// extra time. Falls back to the final `score` when period data isn't present.
const MONTHS_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// Match day as "D Mon", matching the group-stage date format used in the app.
// All 2026 venues are in the Americas (UTC-4…-7) and kick off afternoon/evening
// local, so a late game (e.g. 9:30pm July 3 in Kansas City) is past midnight UTC.
// Shift 7h before formatting so the date reflects the venue's matchday rather
// than rolling onto the next UTC day.
function dMon(iso) {
  const dt = new Date(iso);
  if (isNaN(dt)) return "";
  const local = new Date(dt.getTime() - 7 * 3600 * 1000);
  return local.getUTCDate() + " " + MONTHS_ABBR[local.getUTCMonth()];
}
function regulationScore(c) {
  const ls = c && c.linescores;
  if (Array.isArray(ls) && ls.length >= 2 && ls[0] && ls[1] && ls[0].value != null && ls[1].value != null) {
    return Number(ls[0].value) + Number(ls[1].value);
  }
  return Number(c && c.score);
}

function run() {
  return fetchEvents().then(events => {
    const groupScores = [];
    const koScores = [];
    const koFixtures = { R32: [], R16: [], QF: [], SF: [], F: [] };
    const advancers = { R32: [], R16: [], QF: [], SF: [], F: [] };
    let champion = null;

    // Collect knockout candidates (non-group, real teams). We assign their round
    // by CHRONOLOGICAL ORDER + bracket size below rather than by date windows:
    // knockout rounds never overlap in time, and date-window bucketing can't
    // separate adjacent rounds once late-night kickoffs cross the UTC midnight
    // boundary (which caused R16 ties to leak into R32).
    const koCands = [];
    events.forEach(ev => {
      const comp = (ev.competitions && ev.competitions[0]) || null;
      if (!comp) return;
      const competitors = comp.competitors || [];
      const homeC = competitors.find(c => c.homeAway === "home") || competitors[0];
      const awayC = competitors.find(c => c.homeAway === "away") || competitors[1];
      if (!homeC || !awayC) return;

      const home = team(homeC.team && (homeC.team.displayName || homeC.team.name));
      const away = team(awayC.team && (awayC.team.displayName || awayC.team.name));
      const finished = !!(comp.status && comp.status.type && comp.status.type.completed);
      const bucket = bucketFor(ev, comp);

      if (bucket === "GROUP") {
        if (finished) {
          groupScores.push({ home, away, h: Number(homeC.score), a: Number(awayC.score) });
        }
        return;
      }
      // Real-team knockout fixture (skip "Winner Match N" placeholders).
      if (BY_NORM[norm(home)] && BY_NORM[norm(away)]) {
        koCands.push({ t: Date.parse(ev.date) || 0, date: dMon(ev.date), home, away, finished, homeC, awayC });
      }
    });

    // Rounds in chronological order with their bracket sizes (3rd-place playoff
    // sits between the semis and the final; we don't track it).
    const ROUND_SEQ = [["R32",16],["R16",8],["QF",4],["SF",2],["3P",1],["F",1]];
    koCands.sort((a, b) => a.t - b.t);
    koCands.forEach((c, i) => {
      let round = null, acc = 0;
      for (const [r, n] of ROUND_SEQ) { if (i < acc + n) { round = r; break; } acc += n; }
      if (!round || round === "3P" || !koFixtures[round]) return;
      koFixtures[round].push({ home: c.home, away: c.away, date: c.date });
      if (c.finished) {
        try {
          console.log("KO_DBG " + round + " | " + c.home + " v " + c.away +
            " | score " + c.homeC.score + "-" + c.awayC.score +
            " | ls_home " + JSON.stringify(c.homeC.linescores) +
            " | ls_away " + JSON.stringify(c.awayC.linescores) +
            " | homeKeys " + Object.keys(c.homeC).join(","));
        } catch (e) {}
        koScores.push({ home: c.home, away: c.away, h: regulationScore(c.homeC), a: regulationScore(c.awayC), round });
        const winner = c.homeC.winner ? c.home : (c.awayC.winner ? c.away : null);
        if (winner) {
          if (!advancers[round].includes(winner)) advancers[round].push(winner);
          if (round === "F") champion = winner;
        }
      }
    });

    const out = {
      updatedAt: new Date().toISOString(),
      groupScores,
      koScores,
      koFixtures,
      // The 32 qualifiers are exactly the (real) teams in the R32 fixtures.
      qualifiedR32: (function(){ var s=new Set(); koFixtures.R32.forEach(function(f){ s.add(f.home); s.add(f.away); }); return s.size===32 ? Array.from(s).sort() : []; })(),
      advancers,
      champion,
      // ESPN's scoreboard doesn't carry tournament top-scorer stats; left empty for now.
      // (The leaderboard treats top scorer as provisional anyway.)
      topScorers: []
    };

    if (unmapped.size) console.warn("⚠ Unmapped team names (add to ALIASES):", Array.from(unmapped).join(", "));

    // Preserve any existing topScorers so we don't blank out a manually-set value.
    if (existsSync(OUT)) {
      try {
        const prevJson = JSON.parse(readFileSync(OUT, "utf8"));
        if (Array.isArray(prevJson.topScorers) && prevJson.topScorers.length) {
          out.topScorers = prevJson.topScorers;
        }
      } catch (e) {}
    }

    // Only rewrite if changed (keeps git history clean; workflow also checks)
    const next = JSON.stringify(out, null, 2) + "\n";
    let prev = ""; if (existsSync(OUT)) { try { prev = readFileSync(OUT, "utf8"); } catch (e) {} }
    const prevCmp = prev.replace(/"updatedAt":\s*"[^"]*",?\s*/, "");
    const nextCmp = next.replace(/"updatedAt":\s*"[^"]*",?\s*/, "");
    if (prevCmp === nextCmp) { console.log("No change in results data."); return; }
    writeFileSync(OUT, next);
    console.log(`Wrote ${OUT}: ${groupScores.length} group results, R32 qualifiers ${out.qualifiedR32.length}/32, champion ${champion || "—"}.`);
  });
}

run().catch(e => { console.error(e); process.exit(1); });
