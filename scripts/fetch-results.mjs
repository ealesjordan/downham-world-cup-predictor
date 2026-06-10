// fetch-results.mjs — pulls 2026 World Cup results from API-Football and writes results.json
// Run by GitHub Actions. Requires env var API_FOOTBALL_KEY (set as a repository secret).
// Node 20+ (uses global fetch). No external dependencies.

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) { console.error("Missing API_FOOTBALL_KEY env var."); process.exit(1); }

const BASE = "https://v3.football.api-sports.io";
const LEAGUE = 1, SEASON = 2026;
const OUT = "results.json";

async function api(path) {
  const res = await fetch(BASE + path, { headers: { "x-apisports-key": KEY } });
  if (!res.ok) throw new Error("API " + path + " -> " + res.status);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    console.error("API errors for", path, JSON.stringify(json.errors));
  }
  return json;
}

// ---- Team-name normalisation: map API names to the names used in index.html ----
function norm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}
// Our canonical team names (must match GROUPS in index.html)
const OURS = ["Mexico","South Africa","South Korea","Czechia","Canada","Bosnia & Herzegovina","Qatar","Switzerland","Brazil","Morocco","Haiti","Scotland","USA","Paraguay","Turkey","Australia","Germany","Curaçao","Ivory Coast","Ecuador","Netherlands","Japan","Sweden","Tunisia","Belgium","Egypt","Iran","New Zealand","Spain","Cabo Verde","Saudi Arabia","Uruguay","France","Senegal","Iraq","Norway","Argentina","Algeria","Austria","Jordan","Portugal","DR Congo","Uzbekistan","Colombia","England","Croatia","Ghana","Panama"];
const BY_NORM = {}; OURS.forEach(t => { BY_NORM[norm(t)] = t; });
// Aliases: normalised API spelling -> our canonical name
const ALIASES = {
  "korearepublic":"South Korea", "republicofkorea":"South Korea",
  "czechrepublic":"Czechia",
  "bosniaandherzegovina":"Bosnia & Herzegovina", "bosniaherzegovina":"Bosnia & Herzegovina",
  "unitedstates":"USA", "unitedstatesofamerica":"USA", "usmnt":"USA",
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
  unmapped.add(name);
  return name; // fall through (won't match predictions — surfaces in logs)
}

function roundBucket(round) {
  const r = String(round || "").toLowerCase();
  if (r.includes("group")) return "GROUP";
  if (r.includes("round of 32") || r.includes("round of 32")) return "R32";
  if (r.includes("round of 16")) return "R16";
  if (r.includes("quarter")) return "QF";
  if (r.includes("semi")) return "SF";
  if (r.includes("3rd") || r.includes("third")) return "3P";
  if (r.includes("final")) return "F";
  return "OTHER";
}
const FINISHED = new Set(["FT", "AET", "PEN"]);

async function fetchFixtures() {
  let page = 1, all = [];
  while (true) {
    const j = await api(`/fixtures?league=${LEAGUE}&season=${SEASON}&page=${page}`);
    all = all.concat(j.response || []);
    const total = j.paging && j.paging.total ? j.paging.total : 1;
    if (page >= total) break;
    page++;
  }
  return all;
}

async function fetchTopScorers() {
  try {
    const j = await api(`/players/topscorers?league=${LEAGUE}&season=${SEASON}`);
    return (j.response || []).map(r => ({
      name: r.player && r.player.name,
      goals: (r.statistics && r.statistics[0] && r.statistics[0].goals && r.statistics[0].goals.total) || 0
    })).filter(s => s.name).slice(0, 10);
  } catch (e) { console.error("topscorers failed:", e.message); return []; }
}

function run() {
  return Promise.all([fetchFixtures(), fetchTopScorers()]).then(([fixtures, topScorers]) => {
    const groupScores = [];
    const advancers = { R32: [], R16: [], QF: [], SF: [], F: [] };
    const r32Teams = new Set();
    let champion = null;

    fixtures.forEach(fx => {
      const bucket = roundBucket(fx.league && fx.league.round);
      const home = team(fx.teams.home.name), away = team(fx.teams.away.name);
      const finished = FINISHED.has(fx.fixture.status.short);

      if (bucket === "GROUP") {
        if (finished) {
          const sc = (fx.score && fx.score.fulltime && fx.score.fulltime.home != null) ? fx.score.fulltime : fx.goals;
          groupScores.push({ home, away, h: sc.home, a: sc.away });
        }
        return;
      }
      if (bucket === "R32") { if (fx.teams.home.id) r32Teams.add(home); if (fx.teams.away.id) r32Teams.add(away); }
      if (["R32","R16","QF","SF","F"].includes(bucket) && finished) {
        const winner = fx.teams.home.winner ? home : (fx.teams.away.winner ? away : null);
        if (winner) {
          if (!advancers[bucket].includes(winner)) advancers[bucket].push(winner);
          if (bucket === "F") champion = winner;
        }
      }
    });

    const out = {
      updatedAt: new Date().toISOString(),
      groupScores,
      qualifiedR32: r32Teams.size === 32 ? Array.from(r32Teams).sort() : [],
      advancers,
      champion,
      topScorers
    };

    if (unmapped.size) console.warn("⚠ Unmapped team names (add to ALIASES):", Array.from(unmapped).join(", "));

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
