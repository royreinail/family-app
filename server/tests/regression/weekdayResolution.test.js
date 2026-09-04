// Live bug report — Issue 1: "מה יש לי בשלישי" (bare "Tuesday") resolved to
// the wrong date (2026-09-09, a Wednesday, sent on Friday 2026-09-04) while
// "יום שני הקרוב" (qualified "next Monday") resolved correctly the SAME
// evening — proof the LLM's own weekday-name arithmetic isn't reliably
// consistent regardless of phrasing. classify.js's overrideNamedWeekday
// (and the query/management-path callers of matchNamedWeekday/
// resolveNamedWeekdayDate directly) now resolve every weekday name
// deterministically, in both Hebrew and English, bare or qualified — same
// "unambiguous enough to not trust LLM arithmetic" treatment
// overrideObviousRelativeDate already gives "today"/"tomorrow".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchNamedWeekday, resolveNamedWeekdayDate, overrideNamedWeekday } from '../../src/pipeline/classify.js';

// The exact reference date from the bug report itself: Friday 2026-09-04.
const REFERENCE = '2026-09-04';

// index: 0=Sunday .. 6=Saturday (matches JS's own Date#getUTCDay()
// convention, and classify.js's own WEEKDAY_NAMES table).
const HEBREW_BARE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const ENGLISH_BARE = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Expected dates for each weekday, computed independently by hand from the
// reference date (Friday 2026-09-04) rather than via the function under
// test, so this table is a real oracle, not a tautology: Sunday 09-06,
// Monday 09-07, Tuesday 09-08, Wednesday 09-09, Thursday 09-10, Friday
// 09-04 (today itself), Saturday 09-05.
const EXPECTED = ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-04', '2026-09-05'];

test('matchNamedWeekday + resolveNamedWeekdayDate: every Hebrew weekday, bare, resolves to the correct date', () => {
  HEBREW_BARE.forEach((word, i) => {
    const index = matchNamedWeekday(`מה יש לי ב${word}`);
    assert.equal(index, i, `${word} should match weekday index ${i}`);
    assert.equal(resolveNamedWeekdayDate(REFERENCE, index), EXPECTED[i], `ב${word} should resolve to ${EXPECTED[i]}`);
  });
});

test('matchNamedWeekday + resolveNamedWeekdayDate: every Hebrew weekday, qualified ("יום X הקרוב"), resolves the same way as bare', () => {
  HEBREW_BARE.forEach((word, i) => {
    const index = matchNamedWeekday(`יום ${word} הקרוב`);
    assert.equal(index, i, `יום ${word} הקרוב should match weekday index ${i}`);
    assert.equal(resolveNamedWeekdayDate(REFERENCE, index), EXPECTED[i]);
  });
});

test('matchNamedWeekday: every English weekday, bare and qualified, resolves the correct date', () => {
  ENGLISH_BARE.forEach((word, i) => {
    assert.equal(matchNamedWeekday(`what's on ${word}?`), i, `${word} (bare) should match weekday index ${i}`);
    assert.equal(matchNamedWeekday(`what's on next ${word}?`), i, `next ${word} (qualified) should match weekday index ${i}`);
    assert.equal(resolveNamedWeekdayDate(REFERENCE, i), EXPECTED[i]);
  });
});

test('the exact bug report reproduction: bare "בשלישי" resolves to Tuesday 2026-09-08, not Wednesday 2026-09-09', () => {
  const index = matchNamedWeekday('מה יש לי בשלישי');
  assert.equal(index, 2, 'Tuesday');
  assert.equal(resolveNamedWeekdayDate(REFERENCE, index), '2026-09-08');
});

test('the exact bug report reproduction: qualified "יום שני הקרוב" resolves to Monday 2026-09-07', () => {
  const index = matchNamedWeekday('יום שני הקרוב');
  assert.equal(index, 1, 'Monday');
  assert.equal(resolveNamedWeekdayDate(REFERENCE, index), '2026-09-07');
});

test('resolveNamedWeekdayDate: if today itself IS the named weekday, that means today, not next week', () => {
  // REFERENCE (2026-09-04) is itself a Friday (index 5).
  assert.equal(resolveNamedWeekdayDate(REFERENCE, 5), REFERENCE);
});

test('matchNamedWeekday: no false positive on Hebrew "ה" (definite article) + ordinal "שני" ("the second [thing]")', () => {
  // A real, deliberately-excluded risk (see classify.js's own comment):
  // "ה" is NOT in WEEKDAY_PREFIX_LETTERS, so "השני" never gets stripped
  // down to "שני" and misread as Monday.
  assert.equal(matchNamedWeekday('התור השני שלי אצל הרופא'), null, '"the second appointment" must not resolve to Monday');
});

test('matchNamedWeekday: no match at all when the message names no weekday', () => {
  assert.equal(matchNamedWeekday('Dance class at 4pm'), null);
  assert.equal(matchNamedWeekday('שיעור ריקוד בשעה 4'), null);
  assert.equal(matchNamedWeekday(''), null);
  assert.equal(matchNamedWeekday(undefined), null);
});

test('matchNamedWeekday: "ב" and "ל" prefixes both strip correctly (on/for a weekday)', () => {
  assert.equal(matchNamedWeekday('לשלישי הבא'), 2, 'ל-prefixed Tuesday');
  assert.equal(matchNamedWeekday('בשבת'), 6, 'ב-prefixed Saturday');
});

test('overrideNamedWeekday: fills in candidate.date when a weekday is named, leaves it alone otherwise', () => {
  const withWeekday = overrideNamedWeekday('Dentist Tuesday 4pm', { date: '2000-01-01', time: '16:00' }, REFERENCE);
  assert.equal(withWeekday.date, '2026-09-08');
  assert.equal(withWeekday.time, '16:00', 'other fields untouched');

  const withoutWeekday = overrideNamedWeekday('Dentist at 4pm', { date: '2000-01-01', time: '16:00' }, REFERENCE);
  assert.equal(withoutWeekday.date, '2000-01-01', 'no weekday named — candidate.date is left as the LLM provided it');
});
