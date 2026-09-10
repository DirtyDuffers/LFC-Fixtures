// app.test.mjs — regression tests for index.html's client-side opponent-
// matching and data-merging logic (getH2H, mergeHistorical).
//
// Run with: node app.test.mjs
// (needs Node 12+; no other dependencies)
//
// index.html isn't a module, so this extracts the functions under test
// directly from the real file by name (balanced-brace matching, not
// hardcoded line numbers — resilient to the file growing/shrinking
// elsewhere), rather than keeping a hand-copied duplicate that can drift
// out of sync with the real implementation.
//
// Every test here corresponds to a real bug found and fixed during this
// project's development. When adding a new fix to index.html's matching or
// merge logic, add the regression case here too.

import fs from 'fs';

const HTML_PATH = new URL('./index.html', import.meta.url);
const html = fs.readFileSync(HTML_PATH, 'utf8');

// Extracts a function's exact current source by name: from its `function
// name(` declaration line to the line just before the next top-level
// declaration. Line-based rather than brace-counting — a from-scratch brace
// counter needs to correctly skip regex literals, template interpolation,
// and comments to avoid miscounting, which is exactly the kind of fragile
// hand-rolled JS tokenizer that's easy to get subtly wrong; this project's
// own ad-hoc testing relied on line-based boundaries successfully throughout
// its whole history, so this uses the same proven approach rather than a
// more "elegant" one that turned out to actually be less reliable in
// practice (confirmed directly: an early brace-counting version of this
// grabbed several hundred lines past the real end of getH2H).
function extractFunction(name) {
  const lines = html.split('\n');
  const startIdx = lines.findIndex(l => l.trim().startsWith(`function ${name}(`));
  if (startIdx === -1) throw new Error(`Could not find function ${name}() in index.html — has it been renamed or removed?`);
  const topLevelPattern = /^(function |async function |const |let |document\.|window\.)/;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (topLevelPattern.test(lines[i])) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== getH2H opponent matching ===\n');

function buildGetH2H(allPast) {
  const src = extractFunction('getH2H');
  // getH2H reads a global `allPast` array — the pre-merged output of
  // mergeHistorical(), not H2H_DATA/HIST_RESULTS directly (confirmed by
  // reading the actual function: "Build a normalised map from the single
  // master allPast dataset"). Each test gets its own fresh function
  // instance via `new Function`, so getH2H's internal `_map`/`_dirty` cache
  // never leaks state between tests.
  return new Function('allPast', `${src}\nreturn getH2H;`)(allPast);
}

test('Lens/St Helens: a raw substring collision must be rejected', () => {
  const getH2H = buildGetH2H([{ opponent: 'St Helens', start: new Date('1909-10-18'), score: '1-3', result: 'L' }]);
  assertEqual(getH2H('Lens'), null);
});

test('Roma/AS Roma: legitimate whole-word shortened name must still match', () => {
  const getH2H = buildGetH2H([{ opponent: 'AS Roma', start: new Date('2001-01-01'), score: '1-0', result: 'W' }]);
  const result = getH2H('Roma');
  assertEqual(Array.isArray(result) && result.length === 1, true, 'expected one result');
});

test('Internazionale/Inter Milan: explicit alias must connect them', () => {
  const getH2H = buildGetH2H([{ opponent: 'Inter Milan', start: new Date('1965-01-01'), score: '3-1', result: 'W' }]);
  const result = getH2H('Internazionale');
  assertEqual(Array.isArray(result) && result.length === 1, true, 'expected one result');
});

test('Atlético de Madrid/Atletico Madrid: accent + interposed filler word must both be handled', () => {
  const getH2H = buildGetH2H([{ opponent: 'Atlético de Madrid', start: new Date('2026-09-09'), score: '2-1', result: 'W' }]);
  const result = getH2H('Atletico Madrid');
  assertEqual(Array.isArray(result) && result.length === 1, true, 'expected one result');
});

test('Real Madrid/Atlético de Madrid: sharing "Madrid" must NOT cause a false match', () => {
  const getH2H = buildGetH2H([{ opponent: 'Atlético de Madrid', start: new Date('2026-09-09'), score: '2-1', result: 'W' }]);
  assertEqual(getH2H('Real Madrid'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== mergeHistorical (live ICS feed + stored data merging) ===\n');

function runMergeTest(HIST_RESULTS, H2H_DATA, icsPast) {
  const src = extractFunction('mergeHistorical');
  const fn = new Function('HIST_RESULTS', 'H2H_DATA', `${src}\nreturn mergeHistorical;`)(HIST_RESULTS, H2H_DATA);
  return fn(icsPast);
}

test('Score preference: complete HIST_RESULTS entry beats a scoreless ICS stub', () => {
  const merged = runMergeTest(
    [{ start: '2026-08-16', opponent: 'Como 1907', isHome: true, score: '2-0', result: 'W', competition: 'Friendly', competitive: false }],
    {},
    [{ start: new Date('2026-08-16T18:00:00'), opponent: 'Como 1907', isHome: true, competition: 'Friendly', score: undefined, result: undefined }]
  );
  const entries = merged.filter(m => m.opponent === 'Como 1907');
  assertEqual(entries.length, 1, 'entry count');
  assertEqual(entries[0].score, '2-0', 'score');
});

test('Venue backfill: ICS stub venue fills a stored entry missing one', () => {
  const merged = runMergeTest(
    [{ start: '2026-07-25', opponent: 'Sunderland', isHome: true, score: '4-2', result: 'W', competition: 'Friendly', competitive: false }],
    {},
    [{ start: new Date('2026-07-25T18:00:00'), opponent: 'Sunderland', isHome: true, competition: 'Friendly', venue: 'Geodis Park', score: undefined, result: undefined }]
  );
  const entry = merged.find(m => m.opponent === 'Sunderland');
  assertEqual(entry?.venue, 'Geodis Park');
});

test('Opponent canonicalization: short ICS name resolves to the full stored name, no duplicate', () => {
  const merged = runMergeTest(
    [{ start: '2026-08-02', opponent: 'Leeds United', isHome: true, score: '2-4', result: 'L', competition: 'Friendly', competitive: false }],
    {},
    [{ start: new Date('2026-08-02T18:00:00'), opponent: 'Leeds', isHome: true, competition: 'Friendly', score: undefined, result: undefined }]
  );
  const entries = merged.filter(m => (m.opponent || '').toLowerCase().includes('leeds'));
  assertEqual(entries.length, 1, 'entry count');
  assertEqual(entries[0].opponent, 'Leeds United', 'opponent name');
});

test('Date tolerance: stored entry and a timezone-shifted ICS stub are recognized as the same match', () => {
  const merged = runMergeTest(
    [{ start: '2026-07-29', opponent: 'Wrexham', isHome: true, score: '1-0', result: 'W', competition: 'Friendly', venue: 'Yankee Stadium', competitive: false }],
    {},
    [{ start: new Date('2026-07-30T02:00:00Z'), opponent: 'Wrexham', isHome: null, competition: 'Friendly', score: undefined, result: undefined }]
  );
  const entries = merged.filter(m => m.opponent === 'Wrexham');
  assertEqual(entries.length, 1, 'entry count');
  assertEqual(entries[0].score, '1-0', 'score');
});

test('Accent normalization: accented stored name and plain ICS name are recognized as the same club', () => {
  const merged = runMergeTest(
    [{ start: '2026-09-09', opponent: 'Atlético de Madrid', isHome: true, score: '2-1', result: 'W', competition: 'Champions League', competitive: true }],
    {},
    [{ start: new Date('2026-09-09T18:00:00'), opponent: 'Atletico Madrid', isHome: true, competition: 'Champions League', score: undefined, result: undefined }]
  );
  const entries = merged.filter(m => (m.opponent || '').toLowerCase().replace(/[^a-z]/g, '').includes('madrid'));
  assertEqual(entries.length, 1, 'entry count');
});

test('False-positive guard: Real Madrid stays distinct from Atlético de Madrid', () => {
  const merged = runMergeTest(
    [{ start: '2026-09-09', opponent: 'Atlético de Madrid', isHome: true, score: '2-1', result: 'W', competition: 'Champions League', competitive: true }],
    {},
    [{ start: new Date('2026-09-09T18:00:00'), opponent: 'Real Madrid', isHome: true, competition: 'Champions League', score: undefined, result: undefined }]
  );
  const madridEntries = merged.filter(m => (m.opponent || '').toLowerCase().includes('madrid'));
  assertEqual(madridEntries.length, 2, 'entry count');
  assertEqual(madridEntries.some(m => m.opponent === 'Real Madrid'), true, 'Real Madrid present');
  assertEqual(madridEntries.some(m => m.opponent === 'Atlético de Madrid'), true, 'Atlético de Madrid present');
});

test('Genuinely different fixtures against the same opponent, days apart, are not merged', () => {
  const merged = runMergeTest(
    [{ start: '2026-08-01', opponent: 'Test FC', isHome: true, score: '1-0', result: 'W', competition: 'Friendly', competitive: false }],
    {},
    [{ start: new Date('2026-08-05T18:00:00'), opponent: 'Test FC', isHome: false, competition: 'Friendly', score: undefined, result: undefined }]
  );
  const entries = merged.filter(m => m.opponent === 'Test FC');
  assertEqual(entries.length, 2, 'entry count — these are genuinely two different fixtures');
});

test('Same-day double fixture (venue disambiguation): two matches vs the same opponent, same day, different venue', () => {
  const merged = runMergeTest(
    [
      { start: '2026-08-16', opponent: 'Como 1907', isHome: true, score: '2-0', result: 'W', competition: 'Friendly', venue: 'Anfield', competitive: false },
      { start: '2026-08-16', opponent: 'Como 1907', isHome: true, score: '1-1', result: 'D', competition: 'Friendly', venue: 'AXA Training Centre', competitive: false },
    ],
    {},
    []
  );
  const entries = merged.filter(m => m.opponent === 'Como 1907');
  assertEqual(entries.length, 2, 'both same-day fixtures must survive, not collapse into one');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
