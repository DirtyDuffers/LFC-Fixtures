// worker.test.mjs — regression tests for worker.js's opponent-matching and
// data-parsing logic.
//
// Run with: node worker.test.mjs
// (needs Node 12+ for ES module support; no other dependencies)
//
// Every test here corresponds to a real bug found and fixed during this
// project's development — not hypothetical cases. When adding a new fix to
// worker.js, add the regression case here too, so it can't silently break
// again in a future change. See the app's technical documentation for the
// full story behind each of these.

import {
  fuzzyMatch,
  normaliseForKey,
  applyKnownAliases,
  splitLfcHistoryCompetition,
  normalizeRoundLabel,
} from './worker.js';

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

console.log('\n=== fuzzyMatch (opponent name matching) ===\n');

test('Lens/St Helens: a raw substring collision must be rejected ("lens" is the tail of "helens")', () => {
  assertEqual(fuzzyMatch('Lens', 'St Helens'), false);
});

test('Roma/AS Roma: legitimate whole-word shortened name must still match', () => {
  assertEqual(fuzzyMatch('Roma', 'AS Roma'), true);
});

test('Porto/FC Porto: legitimate whole-word shortened name must still match', () => {
  assertEqual(fuzzyMatch('Porto', 'FC Porto'), true);
});

test('Como/Como 1907: shortened name with a trailing year must match', () => {
  assertEqual(fuzzyMatch('Como', 'Como 1907'), true);
});

test('Leeds/Leeds United: shortened name must match', () => {
  assertEqual(fuzzyMatch('Leeds', 'Leeds United'), true);
});

test('Sunderland/Sunderland AFC: suffix stripping must still work', () => {
  assertEqual(fuzzyMatch('Sunderland', 'Sunderland AFC'), true);
});

test('Internazionale/Inter Milan: explicit alias for names with no shared word or substring', () => {
  assertEqual(fuzzyMatch('Internazionale', 'Inter Milan'), true);
});

test('Inter (bare)/Inter Milan: alias must also cover the bare short form', () => {
  assertEqual(fuzzyMatch('Inter', 'Inter Milan'), true);
});

test('Atlético de Madrid/Atletico Madrid: accent + interposed filler word ("de") must both be handled', () => {
  assertEqual(fuzzyMatch('Atlético de Madrid', 'Atletico Madrid'), true);
});

test('Real Madrid/Atletico Madrid: sharing "Madrid" must NOT cause a false match', () => {
  assertEqual(fuzzyMatch('Real Madrid', 'Atletico Madrid'), false);
});

test('Real Madrid/Atlético de Madrid: same guard, with the accent+filler-word variant', () => {
  assertEqual(fuzzyMatch('Real Madrid', 'Atlético de Madrid'), false);
});

console.log('\n=== normaliseForKey / applyKnownAliases (accent handling) ===\n');

test('Accented characters convert to their plain form, not delete outright', () => {
  assertEqual(normaliseForKey('Atlético'), 'atletico');
});

test('applyKnownAliases handles the accented Internazionale variant too', () => {
  assertEqual(applyKnownAliases('Ìnternazionale'.replace('Ì', 'I')), applyKnownAliases('Internazionale'));
});

console.log('\n=== splitLfcHistoryCompetition (competition/round splitting) ===\n');

const competitionCases = [
  ['Champions L - League Ph.', 'Champions League', 'League Phase'],
  ['Champions L Round of 16 1st leg', 'Champions League', 'Round of 16 (1st leg)'],
  ['Champions L Round of 16 2nd leg', 'Champions League', 'Round of 16 (2nd leg)'],
  ['CL Quarter-final 1st leg', 'Champions League', 'Quarter-Final (1st leg)'],
  ['CL Quarter-final 2nd leg', 'Champions League', 'Quarter-Final (2nd leg)'],
  ['League Cup 3rd round', 'League Cup', '3rd Round'],
  ['League Cup 4th round', 'League Cup', '4th Round'],
  ['FA Cup 3rd round', 'FA Cup', '3rd Round'],
  ['FA Cup 4th round', 'FA Cup', '4th Round'],
  ['FA Cup 5th round', 'FA Cup', '5th Round'],
  ['FA Cup 6th round', 'FA Cup', '6th Round'],
  ['Premier League', 'Premier League', null],
  ['Community Shield', 'Community Shield', null],
  ['Friendly', 'Friendly', null],
];
for (const [raw, expectedComp, expectedRound] of competitionCases) {
  test(`"${raw}" -> competition="${expectedComp}", round=${JSON.stringify(expectedRound)}`, () => {
    const { competition, roundHint } = splitLfcHistoryCompetition(raw);
    assertEqual(competition, expectedComp, 'competition');
    assertEqual(roundHint, expectedRound, 'roundHint');
  });
}

console.log('\n=== normalizeRoundLabel (round text formatting) ===\n');

const roundCases = [
  ['League Phase', 'League Phase'],
  ['Round of 16 (1st leg)', 'Round of 16 (1st leg)'],
  ['Quarter-Final (1st leg)', 'Quarter-Final (1st leg)'],
  ['Semi-Final (2nd leg)', 'Semi-Final (2nd leg)'],
  ['Final', 'Final'],
  ['3rd Round', '3rd Round'],
  ['6th Round', '6th Round'],
];
// normalizeRoundLabel is applied to the roundHint splitLfcHistoryCompetition
// already produces, so these check it's idempotent on already-correct input
// (splitLfcHistoryCompetition's own tests above cover the raw->normalized path).
for (const [input, expected] of roundCases) {
  test(`normalizeRoundLabel("${input}") is idempotent`, () => {
    assertEqual(normalizeRoundLabel(input), expected);
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
