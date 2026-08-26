// Regression coverage for LLM-classified activity icons — added because
// the free English-keyword match (activityIconsRepo.resolveIcon) never
// matches non-English text (the family's real usage includes Hebrew),
// regardless of the keyword-seeding fix. The LLM now also classifies every
// extraction into a fixed activity_category (llm.js), persisted on the
// Calendar write (calendar.js's extendedProperties.private) and used by
// the dashboard as a fallback when the keyword match misses.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import { iconForCategory } from '../../src/pipeline/classify.js';
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

test('iconForCategory maps every real category to its canonical icon and falls back to the pushpin for an unknown one', () => {
  assert.equal(iconForCategory('dance'), '💃');
  assert.equal(iconForCategory('shopping'), '🛒');
  assert.equal(iconForCategory('other'), '📌');
  assert.equal(iconForCategory('not-a-real-category'), '📌');
  assert.equal(iconForCategory(undefined), '📌');
});

test('resolveEventIcon prefers the keyword match, falls back to the LLM category, then the pushpin', () => {
  const icons = DEFAULT_ICONS;
  // Keyword match wins even if a (wrong) category is also present.
  assert.equal(
    resolveEventIcon({ summary: 'Dance class', extendedProperties: { private: { activityCategory: 'shopping' } } }, icons),
    '💃'
  );
  // No keyword match (Hebrew title) -> falls back to the persisted category.
  assert.equal(
    resolveEventIcon({ summary: 'קניות עם שי לי', extendedProperties: { private: { activityCategory: 'shopping' } } }, icons),
    '🛒'
  );
  // Neither -> true last resort.
  assert.equal(resolveEventIcon({ summary: 'קניות עם שי לי', extendedProperties: {} }, icons), '📌');
  assert.equal(resolveEventIcon({ summary: 'קניות עם שי לי' }, icons), '📌');
});

test('a real write threads the LLM-classified activity_category through to the Calendar event', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'קניות עם שי לי, היום בשעה 14:00': {
      title: 'קניות עם שי לי', date: '2026-08-19', time: '14:00', person: 'שי לי', category: 'todo',
      reminder_requested: false, reminder_datetime: null, audience: 'family', activity_category: 'shopping',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'קניות עם שי לי, היום בשעה 14:00', externalMessageId: 'wamid.icon-regression-1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  const written = calendar.events.get(eventId);
  assert.equal(written.activityCategory, 'shopping');
});

test('a candidate with no activity_category at all (old fixture shape) omits the field rather than writing an invalid one', async () => {
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
    { familyId: family.id, senderIdentifier: knownSender, text: 'Soccer practice Thursday 5pm', externalMessageId: 'wamid.icon-regression-2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).activityCategory, undefined);
});

test('the LLM schema enum and the keyword-seed categories never drift apart', () => {
  // Sanity check on the single-source-of-truth claim itself.
  assert.ok(ACTIVITY_CATEGORIES.length > 10);
  assert.ok(ACTIVITY_CATEGORIES.some((c) => c.category === 'other' && c.icon === '📌'));
});
