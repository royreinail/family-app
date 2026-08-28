// Regression coverage for activity icons.
//
// Originally the LLM classified every extraction into one of a small fixed
// set of hardcoded categories (activityCategories.js), each mapped to one
// icon — which is exactly what caused a real bug: "ערב סרט" (Hebrew for
// "movie night") landed on the 📌 pushpin simply because nobody had
// thought to add a "movie" category yet. Roy's call: stop gatekeeping —
// the LLM now picks a real emoji directly per event (llm.js's
// activity_icon, no enum constraint), covering any activity in any
// language without waiting on a hardcoded list to catch up. Costs nothing
// extra: still the one required field in the same single extraction call.
//
// The old category->icon mapping (activityCategories.js, iconForCategory)
// stays only as a read-time fallback for events written *before* this
// changed, and as the source for the still-useful free English-keyword
// match (activityIcons.js's DEFAULT_ICONS/resolveIcon) — unrelated to the
// LLM's field, just a fast local sanity check that runs first.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import { iconForCategory, sanitizeActivityIcon } from '../../src/pipeline/classify.js';
import { resolveIcon, DEFAULT_ICONS } from '../../src/repositories/activityIcons.js';
import { resolveEventIcon } from '../../src/routes/dashboard.js';
import { ACTIVITY_CATEGORIES } from '../../src/integrations/activityCategories.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('DEFAULT_ICONS is derived from the canonical category list and still covers the common keywords', () => {
  assert.ok(DEFAULT_ICONS.some((i) => i.keyword === 'dance' && i.icon === '💃'));
  assert.ok(DEFAULT_ICONS.some((i) => i.keyword === 'birthday' && i.icon === '🎉'));
  assert.ok(DEFAULT_ICONS.some((i) => i.keyword === 'soccer' && i.icon === '⚽'));
});

test('resolveIcon returns null (not a fallback icon) on no keyword match', () => {
  const icons = DEFAULT_ICONS;
  assert.equal(resolveIcon(icons, 'Dance class'), '💃');
  assert.equal(resolveIcon(icons, 'קניות עם שי לי'), null, 'no English keyword in Hebrew text, and that must not be silently papered over with a fallback here');
  assert.equal(resolveIcon(icons, ''), null);
});

test('iconForCategory (legacy read-time fallback only) maps every real category to its canonical icon and falls back to the pushpin for an unknown one', () => {
  assert.equal(iconForCategory('dance'), '💃');
  assert.equal(iconForCategory('shopping'), '🛒');
  assert.equal(iconForCategory('other'), '📌');
  assert.equal(iconForCategory('not-a-real-category'), '📌');
  assert.equal(iconForCategory(undefined), '📌');
});

test('sanitizeActivityIcon accepts a real single emoji and rejects anything that looks like leftover text', () => {
  assert.equal(sanitizeActivityIcon('🎬'), '🎬');
  assert.equal(sanitizeActivityIcon('🏕️'), '🏕️', 'a variation-selector sequence is still one real emoji');
  assert.equal(sanitizeActivityIcon(' 🎉 '), '🎉', 'trims whitespace');
  assert.equal(sanitizeActivityIcon('movie'), '📌', 'a plain word must not pass as an emoji');
  assert.equal(sanitizeActivityIcon(''), '📌');
  assert.equal(sanitizeActivityIcon(null), '📌');
  assert.equal(sanitizeActivityIcon('🎬 movie night!'), '📌', 'a whole phrase with an emoji buried in it is not a clean single icon');
});

test('resolveEventIcon: keyword match, then the icon actually stored on the event, then legacy category, then the pushpin', () => {
  const icons = DEFAULT_ICONS;
  // Keyword match wins even if a (different) stored icon is also present.
  assert.equal(
    resolveEventIcon({ summary: 'Dance class', extendedProperties: { private: { activityIcon: '🛒' } } }, icons),
    '💃'
  );
  // No keyword match (Hebrew title) -> the icon the LLM actually chose for this specific event.
  assert.equal(
    resolveEventIcon({ summary: 'ערב סרט', extendedProperties: { private: { activityIcon: '🎬' } } }, icons),
    '🎬'
  );
  // A stored icon is re-validated on read too, same as at write time.
  assert.equal(
    resolveEventIcon({ summary: 'קניות עם שי לי', extendedProperties: { private: { activityIcon: 'not-an-emoji' } } }, icons),
    '📌'
  );
  // An event written before this changed still has the old field, not activityIcon.
  assert.equal(
    resolveEventIcon({ summary: 'קניות עם שי לי', extendedProperties: { private: { activityCategory: 'shopping' } } }, icons),
    '🛒'
  );
  // Neither -> true last resort.
  assert.equal(resolveEventIcon({ summary: 'קניות עם שי לי', extendedProperties: {} }, icons), '📌');
  assert.equal(resolveEventIcon({ summary: 'קניות עם שי לי' }, icons), '📌');
});

test('a real write threads the LLM-chosen emoji straight through to the Calendar event, any activity, no fixed list', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    // Deliberately something with no hardcoded category ever defined for
    // it — the whole point is this needs no list update to get a real icon.
    'Camping trip this weekend': {
      title: 'Camping trip', date: '2026-08-30', time: '09:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🏕️',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Camping trip this weekend', externalMessageId: 'wamid.icon-regression-1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  const written = calendar.events.get(eventId);
  assert.equal(written.activityIcon, '🏕️');
});

test('the movie-night bug itself: a Hebrew title with no English keyword still gets a real icon, not the pushpin', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'ערב סרט ביום שישי': {
      title: 'ערב סרט', date: '2026-08-28', time: '20:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🎬',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'ערב סרט ביום שישי', externalMessageId: 'wamid.icon-regression-2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).activityIcon, '🎬');
});

test('a malformed activity_icon from the LLM is sanitized before it ever reaches the Calendar event', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dentist tomorrow 9am': {
      title: 'Dentist', date: '2026-08-29', time: '09:00', person: null, category: 'appointment',
      reminder_requested: false, reminder_datetime: null, audience: 'family',
      activity_icon: 'a dentist appointment', // malformed — a whole phrase, not one emoji
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dentist tomorrow 9am', externalMessageId: 'wamid.icon-regression-3' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).activityIcon, '📌', 'never write an unvalidated string straight through as the icon');
});

test('a candidate with no activity_icon at all (old fixture shape) omits the field rather than writing an invalid one', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Soccer practice Thursday 5pm': {
      title: 'Soccer practice', date: '2026-08-20', time: '17:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Soccer practice Thursday 5pm', externalMessageId: 'wamid.icon-regression-4' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).activityIcon, undefined);
});

test('the legacy category list stays populated (still backs the free keyword-seed match and old-event fallback)', () => {
  assert.ok(ACTIVITY_CATEGORIES.length > 10);
  assert.ok(ACTIVITY_CATEGORIES.some((c) => c.category === 'other' && c.icon === '📌'));
});
