// Deterministic app code acting on the LLM's structured output — the LLM
// never decides routing, only reports fields. See rules/defaultRules.js for
// the actual branching logic (data, not code); this module just turns a
// candidate into the facts those rules evaluate, and turns a matched action
// into human copy / calendar payloads.
import { hexToColorId, DEFAULT_COLOR_ID } from '../integrations/googleColors.js';

// Matches the extracted `person` string against real family members so the
// Calendar event can carry that person's actual assigned color. Anything
// short of exactly one confident match — nobody named, several people
// named, no match at all — deliberately falls back to one default color
// rather than guessing which person was meant.
export function resolveEventColorId(personName, familyMembers) {
  if (!personName || !familyMembers?.length) return DEFAULT_COLOR_ID;
  const needle = personName.toLowerCase();
  const matches = familyMembers.filter((m) => needle.includes(m.name.toLowerCase()));
  if (matches.length !== 1) return DEFAULT_COLOR_ID;
  return hexToColorId(matches[0].calendar_color);
}

export function factsFromCandidate(candidate) {
  const hasDate = candidate.date != null && candidate.date !== '';
  const hasTime = candidate.time != null && candidate.time !== '';
  const contentFields = ['title', 'date', 'time', 'person', 'category'];
  const hasAnyField = contentFields.some((f) => candidate[f] != null && candidate[f] !== '');
  return { hasDate, hasTime, hasAnyField, isPureReminder: isReminderOnlyMessage(candidate) };
}

// True when the whole message IS the reminder — the extracted date/time
// exactly match reminder_datetime, meaning there's no separate
// calendar-worthy event distinct from "remind me at this moment" (e.g.
// "remind me to do the laundry at 22:30 today"). False when a real event
// exists at its own date/time and the reminder is for something unrelated
// (e.g. "remind me to pack the gym bag Thursday night, gym class is Friday
// 9am" — acceptance fixture 7's shape), in which case the event still
// belongs on the calendar and the reminder is scheduled independently.
function isReminderOnlyMessage(candidate) {
  if (!candidate.reminder_requested || !candidate.reminder_datetime) return false;
  if (!candidate.date || !candidate.time) return false;
  return candidate.reminder_datetime.startsWith(`${candidate.date}T${candidate.time}`);
}

export function formatDateTime(date, time) {
  if (!date) return '';
  if (!time) return date;
  return `${date} ${time}`;
}

export function confirmReply(candidate) {
  const when = formatDateTime(candidate.date, candidate.time);
  const title = candidate.title || 'Event';
  return `${title}, ${when} — added ✅`;
}

export function qualifyReply(candidate) {
  const title = candidate.title || 'This';
  return `Got it — ${title} on ${candidate.date}. What time?`;
}

export function clarifyReply() {
  return "I couldn't find a date in that — what day is it for?";
}

export function reminderConfirmReply(candidate) {
  const title = candidate.title || 'that';
  return `Got it — I'll remind you: ${title} at ${candidate.time} ✅`;
}

// Extraction only ever gives a start time, but a zero-duration calendar
// event is odd UX — default every write to a 1-hour block. Uses UTC as
// neutral scratch space for the date-rollover arithmetic only; the
// resulting date/time is still wall-clock in the family's own timezone,
// same as the input (see calendar.js's timeZone field on the actual write).
export function addOneHour(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  d.setUTCHours(d.getUTCHours() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

// "Today" in a given IANA timezone, as YYYY-MM-DD — deliberately NOT
// `new Date().toISOString().slice(0,10)`, which is always the server's UTC
// date and silently disagrees with the family's local date for part of
// every day (found as a real bug: messages sent late evening in a
// timezone ahead of UTC got "tomorrow" resolved against yesterday's UTC
// date). en-CA's default date format is already YYYY-MM-DD.
export function todayInTimeZone(timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// The LLM resolves relative dates itself (its one job includes that), but
// "today"/"tomorrow" are unambiguous enough that we don't need to trust an
// LLM's arithmetic for them — a real off-by-one was observed in testing
// ("tomorrow" landing one day later than intended). Deterministically
// override the candidate's date for these two exact cases; anything less
// clear-cut (weekday names, "next Friday", "in two weeks") still goes
// through the LLM's own reasoning against the reference date.
export function overrideObviousRelativeDate(rawInput, candidate, referenceDate) {
  const text = (rawInput || '').toLowerCase();
  if (/\btomorrow\b/.test(text)) return { ...candidate, date: addDays(referenceDate, 1) };
  if (/\btoday\b/.test(text) || /\btonight\b/.test(text)) return { ...candidate, date: referenceDate };
  return candidate;
}

// Backlog 4.1-4.3 (event audience & kid visibility) — the LLM already
// judges 'family' vs 'parent_only' itself (see llm.js's system prompt;
// defaults to 'family' whenever unclear, matching the kid dashboard's
// safe-default choice not to under-show real family events). This is the
// one deterministic override on top of that judgment (4.3's "nice-to-have"
// manual escape hatch, minus any UI to build one — there's no
// event-management screen in Phase 1 to put a toggle on): an explicit
// phrase in the message itself always wins over the LLM's own read.
const PARENT_ONLY_KEYWORDS = /\b(just us parents|just (me|us) parents?|parents? only|adults? only|not for the kids?|no kids)\b/i;
export function overrideExplicitAudienceKeyword(rawInput, candidate) {
  if (PARENT_ONLY_KEYWORDS.test(rawInput || '')) return { ...candidate, audience: 'parent_only' };
  return candidate;
}

// The kid dashboard's one filtering rule: hide events explicitly marked
// parent_only, show everything else (including events with no audience
// metadata at all — e.g. sample/preview events, or anything written before
// this field existed). Pure and pulled out specifically so it's testable
// without the real Google Calendar API dashboard.js otherwise needs.
export function shouldShowOnKidBoard(calendarEvent) {
  return calendarEvent?.extendedProperties?.private?.audience !== 'parent_only';
}
