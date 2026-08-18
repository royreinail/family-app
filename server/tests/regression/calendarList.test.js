// Regression coverage for backlog 2.1's listCalendars() mapping/filter
// logic. Fixture below is shaped from a real calendarList.list() response
// captured in production (emails/calendar IDs replaced with placeholders
// before committing, since this repo is public) — kept because real Google
// responses carry fields and shapes a hand-written guess easily misses:
// a shared calendar someone else owns showing up as reader-only, a
// non-Latin summary (Hebrew, in this case), a family calendar with a
// group.calendar.google.com id distinct from any person's own address,
// and read-only "holiday" calendars Google adds automatically.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapCalendarListItems } from '../../src/integrations/calendar.js';

const REAL_SHAPE_RESPONSE_ITEMS = [
  {
    kind: 'calendar#calendarListEntry',
    id: 'parent@example.com',
    summary: 'Parent Name',
    accessRole: 'owner',
    primary: true,
  },
  {
    kind: 'calendar#calendarListEntry',
    id: 'co-parent@example.com',
    summary: 'co-parent@example.com',
    accessRole: 'reader', // shared with view-only access -- someone else's own calendar
  },
  {
    kind: 'calendar#calendarListEntry',
    id: 'en.jewish#holiday@group.v.calendar.google.com',
    summary: 'Holidays in Israel',
    description: 'Holidays and Observances in Israel',
    accessRole: 'reader', // Google's own auto-added holiday calendar
  },
  {
    kind: 'calendar#calendarListEntry',
    id: 'family01234567890@group.calendar.google.com',
    summary: 'היומן המשפחתי', // "The Family Calendar" -- real non-Latin summary text
    dataOwner: 'parent@example.com',
    accessRole: 'owner',
  },
  {
    kind: 'calendar#calendarListEntry',
    id: 'iw.jewish#holiday@group.v.calendar.google.com',
    summary: 'חגים בישראל',
    accessRole: 'reader',
  },
];

test('mapCalendarListItems keeps only owner/writer calendars, in the shape the app needs', () => {
  const result = mapCalendarListItems(REAL_SHAPE_RESPONSE_ITEMS);
  assert.deepEqual(result, [
    { id: 'parent@example.com', summary: 'Parent Name', primary: true },
    { id: 'family01234567890@group.calendar.google.com', summary: 'היומן המשפחתי', primary: false },
  ]);
});

test('mapCalendarListItems excludes reader-only calendars, including shared and auto-added ones', () => {
  const result = mapCalendarListItems(REAL_SHAPE_RESPONSE_ITEMS);
  const ids = result.map((c) => c.id);
  assert.ok(!ids.includes('co-parent@example.com'), 'a reader-only shared calendar must not be offered as a write target');
  assert.ok(!ids.includes('en.jewish#holiday@group.v.calendar.google.com'), 'Google\'s auto-added holiday calendars are read-only');
});

test('mapCalendarListItems preserves non-Latin summary text unmangled', () => {
  const result = mapCalendarListItems(REAL_SHAPE_RESPONSE_ITEMS);
  const family = result.find((c) => c.id === 'family01234567890@group.calendar.google.com');
  assert.equal(family.summary, 'היומן המשפחתי');
});

test('mapCalendarListItems handles a writer (not just owner) calendar', () => {
  const result = mapCalendarListItems([{ id: 'shared@example.com', summary: 'Shared Family Calendar', accessRole: 'writer' }]);
  assert.deepEqual(result, [{ id: 'shared@example.com', summary: 'Shared Family Calendar', primary: false }]);
});

test('mapCalendarListItems handles an empty or missing item list', () => {
  assert.deepEqual(mapCalendarListItems([]), []);
  assert.deepEqual(mapCalendarListItems(undefined), []);
});
