/**
 * LFC Fixtures – Cloudflare Worker
 * ─────────────────────────────────
 * Fetches the Liverpool FC ICS calendar feed and serves it to the app.
 * The calendar is only ever accessed server-side here — the app never
 * touches it directly, keeping it off the client entirely.
 *
 * The response is cached in KV for 30 minutes so the calendar is fetched
 * at most 48 times per day regardless of how many users hit the app.
 *
 * Also proxies football-data.org attendance lookups (with lfchistory.net
 * as a fallback for score, attendance and opposition manager).
 *
 * NEW: on a Cron Trigger schedule, checks the ICS feed for recently finished
 * Liverpool matches not yet present in data/matches.json (not football-data.org
 * — its free coverage has no category for club friendlies at all). lfchistory.net
 * is treated as the authoritative source — if it has the match, that result is
 * committed straight to main, no review needed, since it also supplies
 * opposition manager and attendance and has proven reliable throughout this
 * project. liverpoolfc.com (via Browser Run) is a fallback only, used when
 * lfchistory.net doesn't have the match yet, and always goes to a GitHub Pull
 * Request for manual review rather than being auto-confirmed — it's
 * AI-extracted and has no second source to corroborate it. See the automation
 * section in the app's technical documentation for the full design and its
 * history of fixes.
 *
 * Setup:
 *  1. Set ICS_URL as a Worker Secret (the Liverpool FC iCal feed URL)
 *  2. Set FOOTBALL_DATA_KEY as a Worker Secret (free key from football-data.org/client/register)
 *     — used only for the standalone ?attendance= endpoint now, not result detection
 *  3. Set GITHUB_TOKEN as a Worker Secret (fine-grained PAT, Contents + Pull requests: read/write,
 *     scoped to just the repo below)
 *  4. Confirm GITHUB_OWNER and GITHUB_REPO below match your actual repo
 *  5. Create a KV namespace, binding name: LFC_CACHE
 *  6. Add a Browser Run binding, name: BROWSER (Cloudflare dashboard → this
 *     Worker → Settings → Bindings — search "Browser Run", the product was
 *     renamed from "Browser Rendering"), compatibility date 2026-03-24 or later
 *  7. Add a Cron Trigger (dashboard → this Worker → Triggers tab — this Worker
 *     is dashboard-deployed, no wrangler.toml)
 *  8. Deploy
 */

const CACHE_TTL_S  = 1800; // 30 minutes
const KV_KEY       = 'lfc_ics_cache_v2';
const LFC_TEAM_ID  = 64;

// Confirmed against the actual repo — github.com/DirtyDuffers/LFC-Fixtures.
// (The site domain, dirtyduffers.github.io, is served from this repo's Pages
// settings, but the repo itself isn't named after the domain — worth
// remembering if this ever needs re-deriving from scratch.)
const GITHUB_OWNER = 'DirtyDuffers';
const GITHUB_REPO  = 'LFC-Fixtures';
const GITHUB_BASE_BRANCH = 'main'; // change to 'master' if that's what the repo uses
const MATCHES_PATH = 'data/matches.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ── Manual trigger for testing the PR flow without waiting for the cron ────
    // Visit WORKER_URL/check-results directly in a browser to run it on demand.
    // Safe to call anytime — it's a no-op if there's nothing new to propose.
    if (url.pathname === '/check-results') {
      const result = await checkForNewResults(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // ── Attendance endpoint: ?attendance=YYYY-MM-DD ─────────────────────────
    if (url.searchParams.has('attendance')) {
      return handleAttendance(url.searchParams.get('attendance'), env);
    }

    // ── Full match data endpoint: ?match=YYYY-MM-DD ─────────────────────────
    // Returns score, attendance, AND opposition manager from lfchistory.net
    if (url.searchParams.has('match')) {
      return handleMatchLookup(url.searchParams.get('match'), env);
    }

    // ── 1. Try KV cache ──────────────────────────────────────────────────────
    try {
      const cached = await env.LFC_CACHE.getWithMetadata(KV_KEY, { type: 'text' });
      if (cached.value) {
        const age = cached.metadata?.fetchedAt
          ? Math.floor((Date.now() - cached.metadata.fetchedAt) / 1000)
          : CACHE_TTL_S;
        if (age < CACHE_TTL_S) {
          return new Response(cached.value, {
            headers: {
              ...CORS_HEADERS,
              'Content-Type': 'text/calendar; charset=utf-8',
              'X-Cache': 'HIT',
              'X-Cache-Age': String(age),
            }
          });
        }
      }
    } catch (_) {}

    // ── 2. Fetch the ICS feed ────────────────────────────────────────────────
    const icsUrl = env.ICS_URL;
    if (!icsUrl) {
      return new Response('ICS_URL secret not configured', {
        status: 500, headers: CORS_HEADERS
      });
    }

    let icsText;
    try {
      const res = await fetch(icsUrl);
      if (!res.ok) throw new Error('Upstream HTTP ' + res.status);
      icsText = await res.text();
    } catch (err) {
      return new Response('Failed to fetch calendar: ' + err.message, {
        status: 502, headers: CORS_HEADERS
      });
    }

    // ── 3. Store in KV ───────────────────────────────────────────────────────
    try {
      await env.LFC_CACHE.put(KV_KEY, icsText, {
        expirationTtl: CACHE_TTL_S + 300,
        metadata: { fetchedAt: Date.now() }
      });
    } catch (_) {}

    return new Response(icsText, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/calendar; charset=utf-8',
        'X-Cache': 'MISS',
        'X-Cache-Age': '0',
      }
    });
  },

  // ── Scheduled entry point (Cron Trigger) ────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForNewResults(env));
  }
};

// ── Attendance handler (legacy endpoint, attendance only) ───────────────────
async function handleAttendance(dateStr, env) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return jsonResponse({ error: 'Invalid date format. Use YYYY-MM-DD.' }, 400);
  }

  const apiKey = env.FOOTBALL_DATA_KEY;
  if (apiKey) {
    try {
      const fdUrl = `https://api.football-data.org/v4/teams/${LFC_TEAM_ID}/matches?dateFrom=${dateStr}&dateTo=${dateStr}&status=FINISHED`;
      const res = await fetch(fdUrl, { headers: { 'X-Auth-Token': apiKey } });
      if (res.ok) {
        const data = await res.json();
        const match = (data.matches || [])[0];
        if (match?.attendance) {
          return jsonResponse({ date: dateStr, attendance: match.attendance, source: 'football-data.org' });
        }
      }
    } catch (_) {}
  }

  try {
    const data = await scrapeMatchFromLfcHistory(dateStr, env);
    if (data?.attendance) {
      return jsonResponse({ date: dateStr, attendance: data.attendance, source: 'lfchistory.net' });
    }
  } catch (_) {}

  return jsonResponse({ date: dateStr, attendance: null });
}

// ── Full match data handler — score, attendance, opposition manager ────────
async function handleMatchLookup(dateStr, env) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return jsonResponse({ error: 'Invalid date format.' }, 400);
  }
  try {
    const data = await scrapeMatchFromLfcHistory(dateStr, env);
    return jsonResponse({ date: dateStr, ...(data || {}) });
  } catch (err) {
    return jsonResponse({ date: dateStr, error: err.message }, 502);
  }
}

// ── lfchistory.net scraping ──────────────────────────────────────────────────
// lfchistory.net has (at least) two different season-listing URL schemes, and
// they are NOT interchangeable — confirmed directly, the hard way. The one
// this Worker used from the start, /SeasonArchive/Archive/{calendar year},
// appears to not include friendlies at all — every single friendly checked
// this session came back "nothing found" from it, for five different
// matches in a row, which in hindsight should have been a stronger signal
// than it was treated as. The other scheme, /season-archive/games/{seasonId}
// (lowercase, and keyed by an internal season ID rather than the year — the
// same ID scheme the offline scraper tool already uses, see the app's
// technical documentation), has a clean table with every game including
// friendlies, complete with venue, which the old approach never provided at
// all. This is now the only path used — the old year-based URL is gone
// entirely (this app now trusts lfchistory.net as the primary, authoritative
// source, so it's worth the URL actually being right rather than kept as an
// unverified fallback).
//
// Score orientation: confirmed against all five real friendlies checked this
// session that this table's score column is already "our score first",
// matching the W/D/L letter directly (e.g. "L | 2-4 | Leeds United" — 2 is
// Liverpool's, matching the L) — unlike liverpoolfc.com below, no isHome-based
// flip is needed for anything read from this table.
//
// Season IDs aren't sequential with year (2025-26 is 135, 2026-27 is 137 —
// not 136), so there's no formula, just a table that needs a new entry each
// pre-season. Find a new one by browsing lfchistory.net's season archive
// dropdown and reading the ID out of the URL it links to.
const LFCHISTORY_SEASON_IDS = {
  2026: 137, // 2026-27
  2025: 135, // 2025-26
};

// Fetches and parses the whole season-games table ONCE — reused for both
// verifying specific candidates and for discovery (finding matches the ICS
// feed never surfaced at all), rather than re-fetching per candidate. That
// per-candidate re-fetching was a real, fixed inefficiency in an earlier
// version of this Worker (the same class of bug found and fixed for FotMob).
async function fetchLfcHistorySeasonTable(seasonStartYear, env) {
  const seasonId = LFCHISTORY_SEASON_IDS[seasonStartYear];
  if (!seasonId) {
    return { rows: null, diagnostic: `No known lfchistory.net season ID for ${seasonStartYear}-${String(seasonStartYear + 1).slice(2)} — add one to LFCHISTORY_SEASON_IDS.` };
  }
  const url = `https://www.lfchistory.net/season-archive/games/${seasonId}`;
  let html;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LFCFixturesApp/1.0)', 'Accept': 'text/html' },
      cf: { cacheTtl: 3600 }, // shorter than a typical day-long cache — this page changes every matchday during the season
    });
    if (!res.ok) return { rows: null, diagnostic: `HTTP ${res.status}` };
    html = await res.text();
  } catch (err) { return { rows: null, diagnostic: `fetch failed: ${err.message}` }; }

  const monthAbbr = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
  const rows = [];
  // Table rows, cell-by-cell — far more reliable than regexing pre-flattened
  // text, since "opponent" and "stadium" are free-text fields with no
  // predictable boundary between them once flattened.
  //
  // Cell POSITIONS are found dynamically, not hardcoded — this page has two
  // separate tables, "Official games" and "Friendlies", and they have
  // different numbers of columns (Official has an extra "Pos" league-position
  // column that Friendlies doesn't). A fixed-index version of this silently
  // broke on every competitive match: cells[3] landed on the W/D/L letter
  // instead of the score for Official rows, found no score pattern there, and
  // skipped the row entirely — confirmed directly against a real Premier
  // League match that never got picked up as a result of this. The columns
  // AFTER the score (Against, Stadium, Competition) are always in the same
  // relative order in both tables, so finding the score cell first and
  // reading everything else relative to it works for both without needing to
  // special-case which table a row came from.
  const trBlocks = html.split('<tr').slice(1);
  for (const rowHtml of trBlocks) {
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m =>
      m[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
    );
    if (cells.length < 6) continue; // not a real data row

    // Find the date in whichever cell has one, rather than assuming index 1.
    const dateCellIndex = cells.findIndex(c => /\d{1,2}\s+\w{3}\s+\d{4}/.test(c));
    if (dateCellIndex === -1) continue;
    const dm = cells[dateCellIndex].match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
    const month = monthAbbr[dm[2]];
    if (!month) continue;
    const iso = `${dm[3]}-${String(month).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;

    // Find the score cell — whichever one matches a "N - N" pattern — rather
    // than assuming a fixed index. Everything else is read relative to it.
    const scoreCellIndex = cells.findIndex(c => /^\d+\s*-\s*\d+$/.test(c));
    if (scoreCellIndex === -1) continue;
    const scoreMatch = cells[scoreCellIndex].match(/(\d+)\s*-\s*(\d+)/);

    let gameUrl = null;
    const linkMatch = rowHtml.match(/<td[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/td>/);
    if (linkMatch) {
      gameUrl = linkMatch[1].startsWith('http') ? linkMatch[1] : `https://www.lfchistory.net${linkMatch[1].startsWith('/') ? '' : '/'}${linkMatch[1]}`;
    }

    const { competition, roundHint } = splitLfcHistoryCompetition(cells[scoreCellIndex + 3] || '');

    rows.push({
      iso,
      score: `${scoreMatch[1]}-${scoreMatch[2]}`, // already "our score first" — see note above
      opponent: cells[scoreCellIndex + 1] || null,
      venue: cells[scoreCellIndex + 2] || null,
      competition,
      roundHint, // NOT written to matches.json automatically — see the note where this is consumed
      gameUrl,
    });
  }
  if (!rows.length) return { rows: null, diagnostic: `Fetched the page but found no parseable rows — layout may have changed.` };
  return { rows, diagnostic: 'ok' };
}

// lfchistory.net's "Competition" column jams the round/stage into the same
// string for knockout matches, and does so inconsistently — three different
// formats confirmed on the same real season's table:
//   "Champions L - League Ph."          (group/league phase)
//   "Champions L Round of 16 1st leg"   (last 16, different abbreviation style)
//   "CL Quarter-final 1st leg"          (quarters, a THIRD abbreviation style)
//   "League Cup 3rd round" / "FA Cup 4th round"
// Left unsplit, a Champions League last-16 match would have been stored with
// competition:"Champions L Round of 16 1st leg" instead of "Champions League"
// — confirmed as a real gap before it ever actually happened, by checking a
// past season's real data rather than waiting for it to occur in production.
//
// The round/stage half IS auto-filled into matches.json (via normalizeRoundLabel
// below), unlike an earlier, more cautious version of this. The original
// "never auto-fill round" rule was written when the concern was genuinely
// about guessing a round from weak signals — that's not what's happening
// here: lfchistory.net states the round explicitly, and extraction is tested
// against every real example from an actual season. Treating an unambiguous,
// tested parse of the trusted source the same as a risky guess was overly
// cautious, especially for the matches (quarter-finals, semis, finals) where
// leaving it blank would be most noticeable and most regrettable.
function splitLfcHistoryCompetition(raw) {
  const patterns = [
    { re: /^Champions L\s*-\s*League Ph\.?$/i, competition: 'Champions League', roundHint: 'League Phase' },
    { re: /^Champions L\s+(.+)$/i, competition: 'Champions League' },
    { re: /^CL\s+(.+)$/i, competition: 'Champions League' },
    { re: /^(?:UEFA\s+)?Europa L(?:eague)?\.?\s+(.+)$/i, competition: 'Europa League' },
    { re: /^(?:UEFA\s+)?Conference L(?:eague)?\.?\s+(.+)$/i, competition: 'Conference League' },
    { re: /^League Cup\s+(.+)$/i, competition: 'League Cup' },
    { re: /^FA Cup\s+(.+)$/i, competition: 'FA Cup' },
  ];
  for (const p of patterns) {
    const m = raw.match(p.re);
    if (m) return { competition: p.competition, roundHint: normalizeRoundLabel(p.roundHint || m[1]) };
  }
  // No known compound pattern matched — covers Premier League, Community
  // Shield, Friendly, and anything else that's already a clean, single
  // concept with no round embedded in it. Used as-is.
  return { competition: raw, roundHint: null };
}

// Normalises lfchistory.net's raw round text ("3rd round", "quarter-final 1st
// leg") into title case matching this app's ACTUAL existing convention —
// verified directly against a real copy of matches.json, not guessed. Every
// example below was checked against real historical entries and matches
// exactly (e.g. "Quarter-Final (1st leg)" appears 6 times in the real data,
// this produces that exact string). Three things the data confirmed that an
// earlier, unverified version of this got wrong:
//  - Cup rounds keep the NUMERAL form ("1st Round".."6th Round"), not spelled
//    out ("First Round") — confirmed against 28-41 real examples per round.
//  - The leg parenthetical uses LOWERCASE "leg" ("(1st leg)"), not "(1st Leg)".
//  - Quarter-Final/Semi-Final ARE hyphenated specifically for the leg-suffixed
//    two-legged variants (6/6 real examples each) — even though older
//    single-match entries elsewhere use "Quarter Final" with no hyphen for a
//    different context this pipeline doesn't produce, since every knockout
//    round lfchistory.net's current format reports always includes a leg.
function normalizeRoundLabel(raw) {
  if (!raw) return raw;
  let s = raw.trim();
  // "1st leg" / "2nd leg" -> "(1st leg)", appended at the end, lowercase "leg".
  // Also consumes an existing surrounding "(...)" if present, so this is
  // idempotent if ever accidentally applied twice — without this, re-running
  // it on its own output ("Round of 16 (1st leg)") left the parentheses
  // behind empty and appended a second copy: "Round of 16 () (1st leg)".
  const legMatch = s.match(/(\d)(st|nd|rd|th)\s+leg/i);
  s = s.replace(/\s*\(?\d(?:st|nd|rd|th)\s+leg\)?/i, '').trim();
  // Ordinal cup rounds keep the numeral: "3rd round" -> "3rd Round"
  s = s.replace(/(\d(?:st|nd|rd|th))\s+round/i, (_, ord) => `${ord} Round`);
  // Hyphenate Quarter-Final / Semi-Final regardless of input spacing/hyphenation
  s = s.replace(/quarter[\s-]?final/i, 'Quarter-Final');
  s = s.replace(/semi[\s-]?final/i, 'Semi-Final');
  // Title-case whatever's left (e.g. "league phase" -> "League Phase"), but
  // keep small words like "of" lowercase — "Round of 16", not "Round Of 16".
  const smallWords = new Set(['of', 'the', 'a', 'an']);
  s = s.split(' ').map((word, i) => {
    if (i > 0 && smallWords.has(word.toLowerCase())) return word.toLowerCase();
    return word.replace(/\b\w/, c => c.toUpperCase());
  }).join(' ');
  if (legMatch) s = `${s} (${legMatch[1]}${legMatch[2].toLowerCase()} leg)`;
  return s;
}

// Finds a specific date within an already-fetched table, and if found,
// follows the link to the individual match page for opposition manager and
// attendance — the table itself doesn't have those two fields.
async function findInLfcHistoryTable(tableRows, dateStr, env) {
  const row = tableRows.find(r => r.iso === dateStr);
  if (!row) return null;

  let attendance = null, oppMgr = null;
  if (row.gameUrl) {
    try {
      const detailRes = await fetch(row.gameUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LFCFixturesApp/1.0)', 'Accept': 'text/html' },
        cf: { cacheTtl: 86400 },
      });
      if (detailRes.ok) {
        const detailText = (await detailRes.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const attM = detailText.match(/Attendance:\s*([\d,]+)/i);
        if (attM) attendance = parseInt(attM[1].replace(/,/g, ''), 10);
        const mgrM = detailText.match(/Opposition manager:\s*([^·]+?)(?:\s*·|\s*Referee)/i);
        if (mgrM) oppMgr = mgrM[1].trim();
      }
    } catch (_) { /* detail page fetch failed — still return the row's own data below */ }
  }

  return { score: row.score, attendance, opp_mgr: oppMgr, venue: row.venue, competition: row.competition, roundHint: row.roundHint, source_url: row.gameUrl };
}

// Convenience wrapper for the standalone ?attendance= and ?match= endpoints
// below, which look up one date at a time and have no reason to hold a table
// in memory between calls the way the automation pipeline does. Not used by
// checkForNewResults() itself — that fetches the table once per run directly.
async function scrapeMatchFromLfcHistory(dateStr, env) {
  const [year, month] = dateStr.split('-').map(Number);
  const seasonStartYear = month >= 7 ? year : year - 1;
  const { rows } = await fetchLfcHistorySeasonTable(seasonStartYear, env);
  if (!rows) return null;
  return findInLfcHistoryTable(rows, dateStr, env);
}

// ── liverpoolfc.com fallback via Browser Run ─────────────────────────────────
// liverpoolfc.com's results page renders client-side (confirmed by fetching it
// directly — the raw HTML has no match data in it, just page chrome), so this
// requires an actual browser to read, not a plain fetch(). Uses Browser Run's
// /json Quick Action, which drives a real headless browser and then uses AI
// (Workers AI) to pull structured data out of whatever it rendered — chosen
// over hand-written CSS selectors specifically because the real page structure
// has never been directly inspected to write reliable selectors against.
//
// Requires a `BROWSER` binding on this Worker (Cloudflare dashboard → this
// Worker → Settings → Bindings → Browser Rendering, or a `[browser]` block in
// wrangler.toml if deploying that way) and a compatibility_date of 2026-03-24
// or later. Only called as a fallback when scrapeMatchFromLfcHistory() has
// nothing yet — never the primary source. Every value returned from here is
// validated before use; nothing from the AI extraction is trusted as-is.
//
// Known risk: Cloudflare's own docs note Quick Actions can't get past sites
// with bot-challenge screens. This may simply not work depending on whether
// liverpoolfc.com has that kind of protection in front of it — genuinely
// untested against the live site as of writing this.
async function tryLiverpoolFcUrl(url, dateStr, opponentHint, env) {
  const schema = {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Match date in YYYY-MM-DD format' },
            homeTeam: { type: 'string', description: 'Full name of the home team' },
            awayTeam: { type: 'string', description: 'Full name of the away team' },
            homeGoals: { type: 'integer', description: "Home team's final goals scored" },
            awayGoals: { type: 'integer', description: "Away team's final goals scored" },
            competition: { type: 'string' },
          },
          required: ['date', 'homeTeam', 'awayTeam', 'homeGoals', 'awayGoals'],
        },
      },
    },
    required: ['matches'],
  };

  const prompt = 'Extract every completed match result shown on this page for Liverpool FC men\'s team. ' +
    'For each one give the date, the full home team name, the full away team name, the home team\'s final ' +
    'goals scored, the away team\'s final goals scored, and the competition name if shown. Only include ' +
    'matches that already have a final score — do not include upcoming fixtures with no result yet.';

  let raw;
  try {
    raw = await env.BROWSER.quickAction('json', {
      url,
      gotoOptions: { waitUntil: 'networkidle0' },
      prompt,
      response_format: { type: 'json_schema', json_schema: schema },
    });
  } catch (err) {
    return { score: null, diagnostic: `Browser Run request itself threw: ${err.message}` };
  }

  // Defensive: quickAction's exact return shape for /json isn't something this
  // code has been able to verify against the live API, so this handles either
  // a Response-like object (call .json()) or an already-parsed value.
  let parsed;
  try {
    if (raw && typeof raw.json === 'function') parsed = await raw.json();
    else parsed = raw;
  } catch (err) {
    return { score: null, diagnostic: `Couldn't parse Browser Run's response as JSON: ${err.message}. Raw type was ${typeof raw}.` };
  }
  // Confirmed shape from a real failed call: {"success":false,"errors":[{...}]} —
  // check this explicitly so a future API-parameter mistake (or a genuine
  // upstream error) surfaces its actual message instead of falling through to
  // the generic "no matches array" diagnostic below.
  if (parsed && parsed.success === false) {
    const errMsg = Array.isArray(parsed.errors) ? parsed.errors.map(e => e.message || JSON.stringify(e)).join('; ') : JSON.stringify(parsed.errors);
    return { score: null, diagnostic: `Browser Run returned success:false — ${errMsg}` };
  }
  const result = parsed?.result ?? parsed; // successful REST-shaped responses wrap in {success, result}
  const matches = result?.matches;
  // Once success:false has already been ruled out above, a missing matches key
  // and an empty matches array mean the same thing — the extraction ran fine
  // but found nothing on the page — so both get the same message rather than
  // the first looking like a different, more alarming failure than the second.
  if (!Array.isArray(matches) || matches.length === 0) {
    return { score: null, diagnostic: `AI extraction found nothing on the page for this match (possibly a bot-protection page, an empty results list, or the season URL guess (${url}) not matching what's actually live).` };
  }

  const candidateMatches = matches.filter(m => {
    if (!m || typeof m.date !== 'string' || !m.date.startsWith(dateStr)) return false;
    return fuzzyMatch(m.homeTeam, opponentHint) || fuzzyMatch(m.awayTeam, opponentHint);
  });
  if (!candidateMatches.length) {
    const sampleDates = matches.slice(0, 5).map(m => m?.date).join(', ');
    return { score: null, diagnostic: `Extracted ${matches.length} match(es) but none matched date ${dateStr} + opponent "${opponentHint}". Sample dates found: [${sampleDates}]` };
  }
  if (candidateMatches.length > 1) {
    // Same opponent, same date, more than one entry — most likely a genuine
    // same-day double fixture (e.g. simultaneous first-team + development
    // squad friendlies), which this function has no reliable way to tell
    // apart by venue/kickoff time from what the page exposes. Guessing which
    // one is "the" match risks silently attributing the wrong score to the
    // wrong fixture, which is worse than surfacing it for manual review.
    return { score: null, diagnostic: `Found ${candidateMatches.length} matches on the same date against "${opponentHint}" — likely a same-day double fixture this function can't disambiguate. Scores found: [${candidateMatches.map(m => `${m.homeGoals}-${m.awayGoals}`).join(', ')}]. Needs manual review.` };
  }
  const candidate = candidateMatches[0];

  // Validate before trusting anything the AI extraction produced.
  const homeGoals = Number(candidate.homeGoals), awayGoals = Number(candidate.awayGoals);
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals) || homeGoals < 0 || awayGoals < 0) {
    return { score: null, diagnostic: `Found a matching date/opponent but goal values failed validation: homeGoals=${JSON.stringify(candidate.homeGoals)}, awayGoals=${JSON.stringify(candidate.awayGoals)}` };
  }
  const isLiverpoolHome = normaliseForKey(candidate.homeTeam).includes('liverpool');
  const isLiverpoolAway = normaliseForKey(candidate.awayTeam).includes('liverpool');
  if (!isLiverpoolHome && !isLiverpoolAway) {
    return { score: null, diagnostic: `Found a matching date/opponent but neither team name contained "Liverpool": homeTeam="${candidate.homeTeam}", awayTeam="${candidate.awayTeam}"` };
  }

  return { score: { homeGoals, awayGoals }, diagnostic: 'ok' };
}

async function getResultFromLiverpoolFC(dateStr, opponentHint, env, isFriendly) {
  const [year, month] = dateStr.split('-').map(Number);
  const seasonStartYear = month >= 7 ? year : year - 1; // same July-cutoff convention used elsewhere in this file
  // liverpoolfc.com restructured its results pages to require an explicit
  // competition filter in the URL — the bare /results/mens/{year} now maps to
  // "all competitions", which explicitly EXCLUDES friendlies. Getting the ICS
  // feed's own competition classification wrong (it's inconsistent — a real
  // match was mislabeled despite matching "friendly" as a substring) used to
  // mean silently checking the wrong page forever. Rather than keep patching
  // the text-classification heuristic, this just tries both pages if the
  // first (based on the classification) comes up empty — removing the
  // dependency on correctly guessing friendly-vs-competitive at all. Costs
  // one extra Browser Run call only in the case where the first guess misses.
  const friendliesUrl = `https://www.liverpoolfc.com/results/mens/${seasonStartYear}/friendlies`;
  const allCompsUrl = `https://www.liverpoolfc.com/results/mens/${seasonStartYear}/all-competitions`;
  const [firstUrl, secondUrl] = isFriendly ? [friendliesUrl, allCompsUrl] : [allCompsUrl, friendliesUrl];

  const first = await tryLiverpoolFcUrl(firstUrl, dateStr, opponentHint, env);
  if (first.score) return first;
  const second = await tryLiverpoolFcUrl(secondUrl, dateStr, opponentHint, env);
  if (second.score) return second;
  // Neither page had it. Report both URLs explicitly rather than picking one —
  // a report that only names the second URL checked reads as if the first
  // (often the more likely one, per the ICS classification) was never tried
  // at all, which isn't true and has caused real confusion about this before.
  const firstIsInformative = first.diagnostic !== 'ok' && !first.diagnostic.startsWith('AI extraction found nothing');
  const secondIsInformative = second.diagnostic !== 'ok' && !second.diagnostic.startsWith('AI extraction found nothing');
  if (firstIsInformative && !secondIsInformative) return { score: null, diagnostic: `[${firstUrl}] ${first.diagnostic}` };
  if (secondIsInformative && !firstIsInformative) return { score: null, diagnostic: `[${secondUrl}] ${second.diagnostic}` };
  return { score: null, diagnostic: `Checked both pages, neither had it — [${firstUrl}]: ${first.diagnostic} | [${secondUrl}]: ${second.diagnostic}` };
}

// ══════════════════════════════════════════════════════════════════════════
// NEW: automatic result detection + GitHub PR proposal
// ══════════════════════════════════════════════════════════════════════════

// ── Main orchestration, callable from the Cron Trigger or the /check-results
// manual-test endpoint. Always returns a summary object rather than throwing,
// so a bad run shows up clearly in logs/response rather than failing silently.
async function checkForNewResults(env) {
  const log = { steps: [] };
  try {
    if (!env.GITHUB_TOKEN) return { error: 'GITHUB_TOKEN not configured', ...log };

    // 1. Which dates did Liverpool play recently? Sourced from the ICS feed
    // (the club's own calendar), NOT football-data.org — football-data.org's
    // free coverage is explicitly limited to named major leagues/cups and has
    // no category for club friendlies at all, so pre-season tour matches and
    // testimonials would silently never be detected if that were the only
    // source. The ICS feed has no such gap, since it's the same feed the app
    // already displays every fixture from.
    const icsText = await getIcsText(env);
    const recentFixtures = parseIcsForRecentPast(icsText, 10);
    log.steps.push(`ICS feed: ${recentFixtures.length} fixture(s) with a known opponent in the last 10 days`);
    if (!recentFixtures.length) return { proposed: 0, ...log };

    // 2. Current matches.json from GitHub
    const file = await getGitHubFile(env, MATCHES_PATH);
    const matchesData = JSON.parse(file.content);

    // 2a. The ICS feed's event text is often a shortened club name ("Leeds"
    // rather than "Leeds United") — the rest of the dataset, and the badge
    // lookups, use the full name. Reconcile against every opponent name
    // already in matches.json before anything else touches f.opponent, so
    // both the dedup check below and whatever gets written use the same name
    // this app already knows the match under, rather than creating a second,
    // never-merging identity for a club it's already played many times.
    const canonicalOpponentNames = new Set();
    matchesData.histResults.forEach(r => { if (r.opponent) canonicalOpponentNames.add(r.opponent); });
    Object.values(matchesData.h2hData).forEach(e => { if (e.name) canonicalOpponentNames.add(e.name); });
    const canonicaliseOpponentName = (icsName) => {
      const norm = normaliseForKey(icsName);
      if ([...canonicalOpponentNames].some(n => normaliseForKey(n) === norm)) return icsName; // already an exact match, nothing to do
      // Alias check first — e.g. "Internazionale" needs to find an existing
      // "Inter Milan" entry, even though neither startsWith() below nor a
      // plain substring check would ever connect them (see
      // applyKnownAliases for why). Returns whatever the EXISTING name's
      // actual spelling is, not a hardcoded guess, since the real historical
      // data might use a different exact casing than assumed.
      const aliasedNorm = applyKnownAliases(icsName);
      const aliasMatch = [...canonicalOpponentNames].find(n => applyKnownAliases(n) === aliasedNorm);
      if (aliasMatch) return aliasMatch;
      // Only auto-correct when exactly one existing name plausibly matches —
      // "Leeds" -> "Leeds United" is safe; if two different existing clubs
      // could both plausibly be it, guessing wrong is worse than leaving the
      // ICS name as-is and letting the PR review step catch it instead.
      const candidates = [...canonicalOpponentNames].filter(n => {
        const cn = normaliseForKey(n);
        return cn.startsWith(norm) || norm.startsWith(cn);
      });
      return candidates.length === 1 ? candidates[0] : icsName;
    };
    recentFixtures.forEach(f => {
      const canonical = canonicaliseOpponentName(f.opponent);
      if (canonical !== f.opponent) {
        log.steps.push(`  Opponent name "${f.opponent}" matched existing "${canonical}" — using that instead`);
        f.opponent = canonical;
      }
    });

    // Same-day, same-opponent fixtures (e.g. a simultaneous first-team +
    // development squad friendly against a touring club) would otherwise
    // collapse into looking like duplicates of each other — the normal dedup
    // key is just date+opponent, which can't tell them apart. Detected here
    // specifically (rather than always keying on venue) so the common single-
    // match case stays on the simpler key: some older automation-added
    // entries predate the venue-capture fix and have no venue stored at all,
    // and always requiring a venue match would risk treating those as "new"
    // again purely because of a missing field, not a genuine difference.
    const baseKeyOf = f => (f.iso || '') + '|' + normaliseForKey(f.opponent);
    const baseKeyCounts = {};
    recentFixtures.forEach(f => { const k = baseKeyOf(f); baseKeyCounts[k] = (baseKeyCounts[k] || 0) + 1; });
    const needsVenueDisambiguation = k => (baseKeyCounts[k] || 0) > 1;

    // Date matching between sources can't require an exact string match — a
    // late-evening kickoff at a non-UK venue can legitimately fall on
    // different calendar dates depending on which timezone a source uses to
    // record it. Confirmed directly: the Wrexham friendly at Yankee Stadium
    // (New York) is recorded as 29 July by the ICS feed, but lfchistory.net
    // (a UK site) has it as 30 July — the evening US kickoff crosses into the
    // next UK calendar day. Exact-match dedup didn't recognize these as the
    // same fixture, so the auto-confirm path committed a second, unreviewed
    // entry for a match that already existed under a different date. One day
    // of tolerance is generous enough to absorb any timezone crossing without
    // being wide enough to risk merging two genuinely different fixtures —
    // the same opponent played on two literally adjacent calendar dates isn't
    // something that happens in practice, unlike a same-day double (handled
    // separately, above, via venue).
    const daysBetween = (isoA, isoB) => {
      const a = new Date(isoA + 'T12:00:00Z'), b = new Date(isoB + 'T12:00:00Z'); // noon UTC avoids DST edge cases
      return Math.abs((a - b) / 86400000);
    };
    const isKnownMatch = (iso, opponent, venue) => matchesData.histResults.some(r => {
      if (!fuzzyMatch(r.opponent, opponent)) return false;
      if (needsVenueDisambiguation((iso) + '|' + normaliseForKey(opponent)) && normaliseForKey(r.venue || '') !== normaliseForKey(venue || '')) return false;
      return daysBetween((r.start || '').slice(0, 10), iso) <= 1;
    });

    log.steps.push(`matches.json: ${matchesData.histResults.length} existing entries (sha ${file.sha.slice(0,7)})`);

    // 3. Filter to genuinely new ones
    const candidates = recentFixtures.filter(f => !isKnownMatch(f.iso, f.opponent, f.venue));
    if (recentFixtures.some(f => needsVenueDisambiguation(baseKeyOf(f)))) {
      log.steps.push(`  Note: multiple fixtures against the same opponent on the same day detected — disambiguating by venue rather than treating one as a duplicate of the other`);
    }
    log.steps.push(`${candidates.length} fixture(s) not yet in matches.json`);

    // 3a. Fetch lfchistory.net's season table(s) once per run — reused for
    // both discovery (below) and every candidate's verification, rather than
    // fetching per candidate (the old design re-fetched the same page for
    // every match needing a check, which was a real, fixed inefficiency).
    // Almost always exactly one season; grouping by season-start-year only
    // matters right at a season boundary, where the 10-day window could
    // technically span two.
    const neededSeasons = [...new Set(recentFixtures.map(f => {
      const [y, m] = f.iso.split('-').map(Number);
      return m >= 7 ? y : y - 1;
    }))];
    const lfcHistoryTables = {}; // seasonStartYear -> array of rows (or [] if unavailable)
    for (const sy of neededSeasons) {
      const { rows, diagnostic } = await fetchLfcHistorySeasonTable(sy, env);
      log.steps.push(`lfchistory.net season table (${sy}-${String(sy + 1).slice(2)}) — ${diagnostic}`);
      lfcHistoryTables[sy] = rows || [];
    }
    const seasonStartYearOf = iso => { const [y, m] = iso.split('-').map(Number); return m >= 7 ? y : y - 1; };
    const allLfcHistoryRows = Object.values(lfcHistoryTables).flat();

    // 3b. Discovery beyond the ICS feed — lfchistory.net's season table lists
    // every game for the season, independently of whatever the club's own
    // calendar publishes, and can catch a match the ICS feed simply never
    // lists at all (the exact gap that prompted this: a closed-doors
    // development-squad friendly on the same day as the public first-team
    // fixture, with only the latter on the calendar).
    //
    // Matching the table against what's already known has to be fuzzy on
    // both opponent name AND date (see isKnownMatch above) — lfchistory.net
    // may format an opponent name slightly differently from the ICS feed or
    // matches.json, and may record the date a day off from other sources for
    // the timezone reason explained above. Fuzzy matching created a problem
    // for the double-header case specifically that's worth keeping in mind
    // here too: if the table shows two entries for the same date+opponent-ish
    // name and only one is already known, there's no way to safely tell which
    // is the new one without a distinguishing field like venue. That
    // situation is only flagged in the log, not auto-added — auto-discovery
    // only fires when it's unambiguous: exactly one table entry for a
    // date+opponent that matches nothing already known.
    const knownMatchesFor = (iso, opponent) =>
      (candidates.filter(f => daysBetween(f.iso, iso) <= 1 && fuzzyMatch(f.opponent, opponent)).length) +
      (matchesData.histResults.filter(r => daysBetween((r.start || '').slice(0, 10), iso) <= 1 && fuzzyMatch(r.opponent, opponent)).length);

    const discoveryGroups = [];
    allLfcHistoryRows.forEach(row => {
      if (!row.opponent) return;
      const existingGroup = discoveryGroups.find(g => daysBetween(g.iso, row.iso) <= 1 && fuzzyMatch(g.opponent, row.opponent));
      if (existingGroup) existingGroup.rows.push(row);
      else discoveryGroups.push({ iso: row.iso, opponent: row.opponent, rows: [row] });
    });
    discoveryGroups.forEach(g => {
      const known = knownMatchesFor(g.iso, g.opponent);
      const extra = g.rows.length - known;
      if (extra <= 0) return; // nothing beyond what's already known here
      if (extra === 1 && g.rows.length === 1) {
        const row = g.rows[0];
        const canonicalOpponent = canonicaliseOpponentName(row.opponent);
        log.steps.push(`  lfchistory.net discovered a match the ICS feed didn't list: ${canonicalOpponent} (${row.iso}) — adding as a candidate`);
        candidates.push({
          iso: row.iso,
          opponent: canonicalOpponent,
          isHome: null, // unknown — the table doesn't state it directly, and nothing here can safely infer it
          competition: row.competition || '',
          venue: row.venue || null,
          _lfcHistoryDiscovered: true,
          _lfcHistoryRow: row,
        });
      } else {
        log.steps.push(`  lfchistory.net shows ${g.rows.length} match(es) against "${g.opponent}" on ${g.iso} but only ${known} already known — likely a same-day double fixture, can't safely tell which is which without a distinguishing field. Scores seen: [${g.rows.map(r => r.score).join(', ')}]. Needs manual review/entry.`);
      }
    });

    log.steps.push(`${candidates.length} fixture(s) not yet in matches.json`);
    if (!candidates.length) return { proposed: 0, ...log };

    // 4. For each candidate: lfchistory.net is treated as gospel — if it has
    // the match, that's used directly with no second-source cross-check,
    // since it's proven reliable throughout this project and is the only
    // source that also supplies opposition manager and attendance.
    // liverpoolfc.com (via Browser Run) is a fallback only, used when
    // lfchistory.net doesn't have the match yet, and always goes to a PR for
    // review rather than being auto-confirmed — it's AI-extracted and has no
    // second source to corroborate it.
    const autoConfirmed = [];
    const needsReview = [];
    for (const f of candidates) {
      const compLower = (f.competition || '').toLowerCase();
      // Substring match, not exact — the ICS feed's competition text varies
      // ("Friendly Match", "Pre-Season Friendly", etc.), not always the bare
      // word "Friendly".
      const isFriendly = compLower.includes('friendly') || compLower.includes('testimonial');
      const scoreToResult = (s) => { const [a, b] = s.split('-').map(Number); return a > b ? 'W' : a < b ? 'L' : 'D'; };
      const baseEntry = {
        start: f.iso,
        opponent: f.opponent,
        isHome: f.isHome,
        competition: f.competition || '',
        ...(f.venue ? { venue: f.venue } : {}),
        competitive: !isFriendly,
      };

      // lfchistory.net-discovered candidates already carry their row directly
      // (found while building the table above) — no need to search again.
      const lfcRow = f._lfcHistoryRow || (lfcHistoryTables[seasonStartYearOf(f.iso)] || []).find(r => r.iso === f.iso);

      if (lfcRow) {
        const detail = await findInLfcHistoryTable([lfcRow], f.iso, env);
        const roundNote = detail.roundHint ? ` — round: "${detail.roundHint}"` : '';
        log.steps.push(`  ${f.opponent} (${f.iso}): lfchistory.net — ok (${detail.score})${roundNote}`);
        autoConfirmed.push({
          ...baseEntry,
          competition: detail.competition || baseEntry.competition, // lfchistory.net's cleaned name wins — see splitLfcHistoryCompetition
          venue: baseEntry.venue || detail.venue || null,
          score: detail.score,
          result: scoreToResult(detail.score),
          ...(detail.roundHint ? { round: detail.roundHint } : {}),
          ...(detail.opp_mgr ? { opp_mgr: detail.opp_mgr } : {}),
          ...(detail.attendance ? { attendance: detail.attendance } : {}),
        });
        continue;
      }
      log.steps.push(`  ${f.opponent} (${f.iso}): lfchistory.net — no confirmed result yet`);

      if (f.isHome === null) {
        // Discovered via lfchistory.net's table but somehow not matched just
        // above (shouldn't normally happen), or some other path with unknown
        // home/away — liverpoolfc.com's score can't be safely oriented
        // without knowing this, so there's nothing further to try here.
        log.steps.push(`  ${f.opponent} (${f.iso}): home/away unknown, can't safely check liverpoolfc.com — needs manual entry`);
        needsReview.push({
          ...baseEntry, score: null, result: null,
          _source: 'Not found on lfchistory.net, and home/away is unknown so liverpoolfc.com could not be safely checked — needs manual entry',
        });
        continue;
      }

      if (!env.BROWSER) {
        log.steps.push(`  ${f.opponent} (${f.iso}): no confirmed result from lfchistory.net, and BROWSER binding not configured for the liverpoolfc.com fallback — skipping`);
        continue;
      }

      let lfcFallback;
      try { lfcFallback = await getResultFromLiverpoolFC(f.iso, f.opponent, env, isFriendly); }
      catch (err) { lfcFallback = { score: null, diagnostic: `threw unexpectedly: ${err.message}` }; }
      log.steps.push(`  ${f.opponent} (${f.iso}): liverpoolfc.com — ${lfcFallback.diagnostic}`);

      if (!lfcFallback.score) {
        log.steps.push(`  ${f.opponent} (${f.iso}): no confirmed result from either source yet, skipping`);
        continue;
      }
      const score = f.isHome
        ? `${lfcFallback.score.homeGoals}-${lfcFallback.score.awayGoals}`
        : `${lfcFallback.score.awayGoals}-${lfcFallback.score.homeGoals}`;
      needsReview.push({
        ...baseEntry, score, result: scoreToResult(score),
        _source: 'liverpoolfc.com only — lfchistory.net had nothing yet, and this fallback is always reviewed rather than auto-confirmed',
      });
    }
    log.steps.push(`${autoConfirmed.length} auto-confirmed (lfchistory.net), ${needsReview.length} need review (liverpoolfc.com fallback or unresolved)`);
    if (!autoConfirmed.length && !needsReview.length) return { proposed: 0, ...log };

    // 5. Auto-confirmed entries go straight to main — no PR, since
    // lfchistory.net is trusted as gospel here.
    let autoCommitted = 0;
    let currentFile = file, currentData = matchesData;
    if (autoConfirmed.length) {
      const updatedHist = [...currentData.histResults, ...autoConfirmed]
        .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      const commitMessage = `Auto-confirm ${autoConfirmed.length} result(s) from lfchistory.net: ` +
        autoConfirmed.map(e => `${e.opponent} ${e.score} (${e.start})`).join(', ');
      await updateGitHubFile(env, GITHUB_BASE_BRANCH, MATCHES_PATH, JSON.stringify({ ...currentData, histResults: updatedHist }), currentFile.sha, commitMessage);
      autoCommitted = autoConfirmed.length;
      log.steps.push(`Committed directly to ${GITHUB_BASE_BRANCH}: ${autoConfirmed.length} result(s)`);
      // Re-fetch — the sha just changed, and anything below needs the current one
      currentFile = await getGitHubFile(env, MATCHES_PATH);
      currentData = JSON.parse(currentFile.content);
    }

    // 6. Anything needing review (liverpoolfc.com fallback, or genuinely
    // unresolved) still goes through a PR exactly as before.
    let prUrl = null;
    if (needsReview.length) {
      const cleanEntries = needsReview.filter(e => e.score).map(({ _source, ...rest }) => rest);
      if (cleanEntries.length) {
        const updatedHist = [...currentData.histResults, ...cleanEntries]
          .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
        const branchName = 'auto/new-results-' + Date.now();
        await createGitHubBranch(env, branchName);
        const commitMessage = `Add ${cleanEntries.length} result(s) needing review: ` +
          cleanEntries.map(e => `${e.opponent} (${e.start.slice(0,10)})`).join(', ');
        await updateGitHubFile(env, branchName, MATCHES_PATH, JSON.stringify({ ...currentData, histResults: updatedHist }), currentFile.sha, commitMessage);
        prUrl = await createGitHubPR(env, branchName, needsReview.filter(e => e.score));
        log.steps.push(`PR opened for ${cleanEntries.length} result(s) needing review: ${prUrl}`);
      }
    }

    return { autoConfirmed: autoCommitted, needsReview: needsReview.length, prUrl, ...log };
  } catch (err) {
    log.steps.push('ERROR: ' + err.message);
    return { error: err.message, ...log };
  }
}

// Converts accented characters to their plain-Latin equivalent instead of
// just deleting them — confirmed as a real bug: the old normaliseForKey used
// [^a-z0-9] to strip anything non-alphanumeric, which treats "é" as junk to
// remove entirely rather than a letter to convert, turning "Atlético" into
// "atltico" (missing the e) instead of "atletico". That alone was enough to
// make "Atlético de Madrid" and "Atletico Madrid" normalise to two
// completely different strings and be treated as different opponents.
function stripAccents(name) {
  return (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Normalises an opponent name for de-duplication comparisons only — not used
// for display or storage, just to make "Sunderland" and "Sunderland AFC"
// match against each other reliably.
function normaliseForKey(name) {
  return stripAccents(name || '').toLowerCase()
    .replace(/\bafc\b|\bfc\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// Explicit name aliases for clubs known by multiple, structurally unrelated
// names — no amount of substring/prefix/word-boundary matching can connect
// them, since they share no common word or substring relationship at all.
// "Internazionale" is one unbroken word, so "inter" never appears in it as a
// separate word the way "Roma" does within "AS Roma" — this needs an
// explicit alias, same as the client-side fix for the same club (found via
// the exact same symptom: an upcoming Inter Milan fixture showing no
// previous meetings despite Liverpool having played them many times).
// Extend this if another club with the same kind of naming gap comes up.
function applyKnownAliases(name) {
  const n = stripAccents(name || '').toLowerCase().trim();
  if (/^(fc )?internazionale( milano)?$/.test(n) || n === 'inter') return 'intermilan';
  return normaliseForKey(name);
}

// Same idea as normaliseForKey, but keeps spaces — needed for word-boundary
// matching below, since normaliseForKey strips all whitespace and leaves no
// boundary information to check against at all.
function normaliseKeepingSpaces(name) {
  return stripAccents(name || '').toLowerCase().replace(/\bafc\b|\bfc\b/g, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Checks whether `needle` appears in `haystack` as a whole word (or sequence
// of words), not as an arbitrary substring anywhere inside another word.
// Confirmed as a real bug via the app's own client-side equivalent: a naive
// haystack.includes(needle) check let "Lens" (the French club) match "St
// Helens", purely because "lens" happens to be the literal last four
// characters of "Helens" — nothing to do with word boundaries, just
// character coincidence that a raw substring check can't tell apart from a
// genuine partial name.
function wordBoundaryContains(haystack, needle) {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|\\s)' + escaped + '(\\s|$)').test(haystack);
}

// A second, real duplicate confirmed the word-boundary fix above wasn't
// enough on its own: "Atlético de Madrid" and "Atletico Madrid" both refer
// to the same club, but neither is a contiguous substring of the other —
// the interposed "de" breaks contiguity even once the accent is fixed.
// This compares the SET of significant words instead (ignoring filler words
// like "de"/"of"/"the"), matching if one set is a subset of the other —
// same reasoning as the shortened-name case (a bare "Atletico" should still
// match "Atletico Madrid"), just tolerant of an interposed filler word too.
// Requiring the full set (not just any one shared word) keeps this from
// re-introducing a false positive: "Real Madrid" and "Atletico Madrid"
// share "madrid" but are correctly rejected, since neither's word set is a
// subset of the other's.
const FILLER_WORDS = new Set(['de', 'of', 'the', 'and', 'la', 'los', 'las', 'el']);
function significantWords(name) {
  return normaliseKeepingSpaces(name).split(' ').filter(w => w && !FILLER_WORDS.has(w));
}
function significantWordSetMatch(a, b) {
  const wa = significantWords(a), wb = significantWords(b);
  if (!wa.length || !wb.length) return false;
  const setA = new Set(wa), setB = new Set(wb);
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  return [...smaller].every(w => larger.has(w));
}

// Opponent-name equality for matching across sources that may format a name
// slightly differently (e.g. "Sunderland" vs "Sunderland AFC", or "Como" vs
// "Como 1907"). Exact match after full normalisation covers the suffix case;
// the alias check covers clubs with genuinely unrelated common names
// (Internazionale/Inter Milan); word-boundary containment (not raw
// substring) covers the shortened-name case without the same risk a raw
// .includes() check has on short names; the significant-word-set check
// covers names that differ by an interposed filler word (Atlético de
// Madrid vs Atletico Madrid) that word-boundary containment alone can't.
function fuzzyMatch(a, b) {
  const na = normaliseForKey(a), nb = normaliseForKey(b);
  if (na === nb) return true;
  if (applyKnownAliases(a) === applyKnownAliases(b)) return true;
  const wa = normaliseKeepingSpaces(a), wb = normaliseKeepingSpaces(b);
  if (wordBoundaryContains(wa, wb) || wordBoundaryContains(wb, wa)) return true;
  return significantWordSetMatch(a, b);
}

// ── ICS feed fetch + lightweight parse ──────────────────────────────────────
// Reuses the KV cache when fresh (same cache the main endpoint serves from),
// otherwise fetches ICS_URL directly — this never needs to be more current
// than the main endpoint already keeps it.
async function getIcsText(env) {
  try {
    const cached = await env.LFC_CACHE.get(KV_KEY);
    if (cached) return cached;
  } catch (_) {}
  const icsUrl = env.ICS_URL;
  if (!icsUrl) throw new Error('ICS_URL secret not configured');
  const res = await fetch(icsUrl);
  if (!res.ok) throw new Error('Failed to fetch ICS feed: HTTP ' + res.status);
  return res.text();
}

// Minimal server-side port of the app's own parseICS()/enrich() logic — just
// enough to recover date + opponent + isHome + competition for past events in
// a recent window. Deliberately does NOT attempt to extract a score from the
// ICS text: the app's own client-side parser doesn't do this either (SUMMARY
// only ever contains "Home v Away", never a score), so score always comes
// from the lfchistory.net lookup in checkForNewResults() instead.
function parseIcsForRecentPast(icsText, daysBack) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const cutoff = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const lines = icsText.replace(/\r\n[ \t]/g, '').replace(/\r/g, '').split('\n');
  const results = [];
  let cur = null, inAlarm = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VALARM') { inAlarm = true; continue; }
    if (line === 'END:VALARM') { inAlarm = false; continue; }
    if (inAlarm) continue;
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT' && cur) {
      if (cur.start && cur.start < now && cur.start >= cutoff) {
        const enriched = enrichIcsEvent(cur);
        if (enriched.isHome !== null && enriched.opponent) results.push(enriched);
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const ci = line.indexOf(':'); if (ci === -1) continue;
    const key = line.slice(0, ci).split(';')[0].toUpperCase();
    const val = line.slice(ci + 1);
    if (key === 'SUMMARY') cur.summary = decodeIcsValue(val);
    if (key === 'DESCRIPTION') cur.description = decodeIcsValue(val);
    if (key === 'LOCATION') cur.location = decodeIcsValue(val);
    if (key === 'DTSTART') cur.start = parseIcsDate(val);
  }
  return results;
}

function decodeIcsValue(v) {
  return v.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ').replace(/\\\\/g, '\\').trim();
}

function parseIcsDate(v) {
  const s = v.trim();
  const y = +s.slice(0, 4), mo = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const h = +s.slice(9, 11) || 0, mi = +s.slice(11, 13) || 0, sc = +s.slice(13, 15) || 0;
  return s.endsWith('Z') ? new Date(Date.UTC(y, mo, d, h, mi, sc)) : new Date(y, mo, d, h, mi, sc);
}

function enrichIcsEvent(e) {
  const s = e.summary || '';
  let home = '', away = '', isHome = null;
  const vs = s.split(/\s+v(?:s)?\.?\s+/i);
  if (vs.length === 2) { home = stripEmojiSimple(vs[0].trim()); away = stripEmojiSimple(vs[1].trim()); }
  const lfc = ['liverpool', 'lfc'];
  if (lfc.some(n => home.toLowerCase().includes(n))) isHome = true;
  if (lfc.some(n => away.toLowerCase().includes(n))) isHome = false;
  const opponent = isHome === true ? away : isHome === false ? home : null;
  let competition = '';
  if (e.description) {
    const firstLine = e.description.split('\n')[0].trim();
    const pipeIdx = firstLine.indexOf('|');
    competition = (pipeIdx > 0 ? firstLine.slice(0, pipeIdx) : firstLine).trim();
  }
  const y = e.start.getUTCFullYear(), mo = e.start.getUTCMonth() + 1, d = e.start.getUTCDate();
  const iso = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  // Same fallback as the app's own client-side enrich(): the ICS feed reliably
  // sets LOCATION for away/neutral games but often omits it for home fixtures,
  // so default to Anfield when it's missing and this is a home match.
  const venue = e.location || (isHome === true ? 'Anfield' : '');
  return { start: e.start, iso, opponent, isHome, competition, venue };
}

function stripEmojiSimple(str) {
  return str.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{1F300}-\u{1F9FF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}]/gu, '').replace(/  +/g, ' ').trim();
}

// ── GitHub API helpers ───────────────────────────────────────────────────────

// Portable UTF-8 <-> base64 conversion. atob()/btoa() alone only handle strings
// where every character is a single byte (0-255) — any accented name (this data
// is full of them: "Mönchengladbach", "Gérard Houllier") breaks that assumption.
// This goes through TextEncoder/TextDecoder instead of the legacy escape()/
// unescape() trick, since escape/unescape are deprecated and their availability
// in the Workers runtime isn't guaranteed the way TextEncoder/TextDecoder is.
function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function utf8ToBase64(str) { return uint8ToBase64(new TextEncoder().encode(str)); }
function base64ToUtf8(b64) { return new TextDecoder().decode(base64ToUint8(b64)); }

function githubHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'LFCFixturesWorker/1.0',
  };
}

// Retries a fetch on 5xx responses or network errors (transient GitHub/network
// blips — a 504 like the one that actually happened here) with a short
// backoff between attempts. Does NOT retry 4xx responses, since those are
// real errors (bad auth, wrong path, etc.) that won't fix themselves.
async function fetchWithRetry(url, options, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  throw lastErr;
}

async function getGitHubFile(env, path) {
  const metaUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BASE_BRANCH}`;

  // GitHub's Contents API only inlines base64 content in the JSON response for
  // files up to 1 MB — above that (matches.json is well past that now) the
  // `content` field comes back as an empty string. Metadata (including `sha`)
  // is unaffected by file size, so that's still fetched from the Contents API,
  // but the actual content now comes from raw.githubusercontent.com instead of
  // the Contents API's .raw media type — a CDN purpose-built for serving raw
  // blob content at any size, which should be more reliable for a file this
  // size than repeatedly hitting api.github.com for it (a 504 from exactly
  // that endpoint is what prompted this change).
  const metaRes = await fetchWithRetry(metaUrl, { headers: githubHeaders(env) });
  if (!metaRes.ok) throw new Error(`GitHub get file metadata HTTP ${metaRes.status}: ${await metaRes.text()}`);
  const meta = await metaRes.json();

  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BASE_BRANCH}/${path}`;
  const rawRes = await fetchWithRetry(rawUrl, { headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}` } });
  if (!rawRes.ok) throw new Error(`raw.githubusercontent.com HTTP ${rawRes.status}: ${await rawRes.text()}`);
  const content = await rawRes.text();

  return { content, sha: meta.sha };
}

async function createGitHubBranch(env, branchName) {
  const refUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/${GITHUB_BASE_BRANCH}`;
  const refRes = await fetchWithRetry(refUrl, { headers: githubHeaders(env) });
  if (!refRes.ok) throw new Error(`GitHub get ref HTTP ${refRes.status}: ${await refRes.text()}`);
  const refData = await refRes.json();
  const baseSha = refData.object.sha;

  const createUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs`;
  const createRes = await fetchWithRetry(createUrl, {
    method: 'POST',
    headers: githubHeaders(env),
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  if (!createRes.ok) throw new Error(`GitHub create branch HTTP ${createRes.status}: ${await createRes.text()}`);
}

async function updateGitHubFile(env, branchName, path, newContent, sha, message) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  // Safe to retry even though this writes: GitHub's sha-based optimistic
  // concurrency check means a retry after a successful-but-lost response
  // would fail with a 409 (stale sha) rather than writing a second time.
  const res = await fetchWithRetry(url, {
    method: 'PUT',
    headers: githubHeaders(env),
    body: JSON.stringify({
      message,
      content: utf8ToBase64(newContent),
      sha,
      branch: branchName,
    }),
  });
  if (!res.ok) throw new Error(`GitHub update file HTTP ${res.status}: ${await res.text()}`);
}

async function createGitHubPR(env, branchName, newEntries) {
  const title = newEntries.length === 1
    ? `Add result (needs review): Liverpool ${newEntries[0].score} ${newEntries[0].opponent} (${newEntries[0].start})`
    : `Add ${newEntries.length} new results (need review)`;
  const body = [
    'Proposed by the automated result checker. lfchistory.net had nothing for these yet, so this came from the liverpoolfc.com fallback instead — please verify the score against the actual match before merging (this path is AI-extracted and not cross-checked against a second source), plus the round/stage for cup competitions, which is intentionally left blank for manual review.',
    '',
    '| Date | Opponent | H/A | Score | Result | Competition | Venue |',
    '|---|---|---|---|---|---|---|',
    ...newEntries.map(e =>
      `| ${e.start} | ${e.opponent} | ${e.isHome ? 'H' : 'A'} | ${e.score} | ${e.result} | ${e.competition} | ${e.venue || '—'} |`
    ),
  ].join('\n');

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls`;
  const res = await fetch(url, {
    method: 'POST',
    headers: githubHeaders(env),
    body: JSON.stringify({ title, head: branchName, base: GITHUB_BASE_BRANCH, body }),
  });
  if (!res.ok) throw new Error(`GitHub create PR HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.html_url;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ── wrangler.toml addition needed for the Cron Trigger ──────────────────────
// Add this to wrangler.toml (not to this file) to run the check every 3 hours:
//
//   [triggers]
//   crons = ["0 */3 * * *"]
//
// Then redeploy with `wrangler deploy`. Cron Triggers are available on
// Cloudflare's free plan.

// ── Exports for the test suite (worker.test.mjs) ────────────────────────────
// Named exports alongside the existing `export default` above — standard ESM,
// and harmless for Cloudflare, which only ever uses the default export for
// the actual Worker. Lets the test suite import these functions directly
// from this file rather than extracting/duplicating them, so tests always
// run against the real, current source, not a stale copy.
export {
  stripAccents,
  normaliseForKey,
  normaliseKeepingSpaces,
  applyKnownAliases,
  wordBoundaryContains,
  significantWords,
  significantWordSetMatch,
  fuzzyMatch,
  splitLfcHistoryCompetition,
  normalizeRoundLabel,
};
