// Deterministic app code acting on the LLM's structured output — the LLM
// never decides routing, only reports fields. See rules/defaultRules.js for
// the actual branching logic (data, not code); this module just turns a
// candidate into the facts those rules evaluate, and turns a matched action
// into human copy / calendar payloads.
import { hexToColorId, DEFAULT_COLOR_ID } from '../integrations/googleColors.js';
import { ACTIVITY_CATEGORIES } from '../integrations/activityCategories.js';

// Matches a free-text string against real family members. Anything short
// of exactly one confident match — nobody named, several people named, no
// match at all — deliberately returns null rather than guessing which
// person was meant. Shared by color resolution and item 6's person-
// correction matching so "who does this name refer to" is answered
// exactly one way everywhere.
export function matchSingleFamilyMember(text, familyMembers) {
  if (!text || !familyMembers?.length) return null;
  const needle = text.toLowerCase();
  const matches = familyMembers.filter((m) => needle.includes(m.name.toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}

// The Calendar event's color follows whichever real family member the
// extracted `person` confidently matches; falls back to one default color
// rather than guessing.
export function resolveEventColorId(personName, familyMembers) {
  const match = matchSingleFamilyMember(personName, familyMembers);
  return match ? hexToColorId(match.calendar_color) : DEFAULT_COLOR_ID;
}

// Item 6 — a forwarded message often doesn't say who it's for (it wasn't
// written to the bot directly, so the sender's own context is missing).
// When the extracted `person` doesn't confidently match a real family
// member, default to whoever forwarded it — but only for messages Meta
// itself flags as forwarded (message.context.forwarded, threaded through
// from webhook.js), never for something the sender typed directly: most
// captured events are about a kid, not the parent doing the typing, so
// defaulting to "the sender" for an ordinary typed message would be wrong
// far more often than right. The assumption is marked (`personAssumed`),
// not silent — confirmReply/qualifyReply state it explicitly, and
// pipeline.js's person-correction paths can override it.
export function applyForwardedSenderDefault(candidate, { wasForwarded, senderFamilyMember, familyMembers }) {
  if (!wasForwarded || !senderFamilyMember) return candidate;
  if (matchSingleFamilyMember(candidate.person, familyMembers)) return candidate; // already resolves to someone real
  return { ...candidate, person: senderFamilyMember.name, personAssumed: true };
}

// Item 6 — recognizes a short follow-up ("actually for Theo", "change it
// to Mia", "לא, זה בשביל תיאו") naming a different family member, so a
// wrongly-assumed (or simply wrong) person can be corrected after the
// fact — whether sent as a bare next message or a quoted reply (see
// pipeline.js for both call sites). Deliberately strict, same spirit as
// commands.js's isBareTimeAnswer: a genuinely new request that happens to
// mention a family member's name elsewhere ("Dance class for Mia Friday")
// must still go through normal extraction, not get swallowed as a
// correction to something else entirely.
const PERSON_CORRECTION_FILLER = /\b(for|actually|it's|its|it|change|to|that's|thats|instead|please|not|this|is)\b/gi;
const PERSON_CORRECTION_FILLER_HE = /עבור|במקום|זה|זאת|בשביל|תשני|תשנה|לא|בעצם/g;
export function matchBarePersonCorrection(text, familyMembers) {
  const raw = (text || '').trim();
  const match = matchSingleFamilyMember(raw, familyMembers);
  if (!match) return null;
  const residue = raw
    .toLowerCase()
    .replace(match.name.toLowerCase(), ' ')
    .replace(PERSON_CORRECTION_FILLER, ' ')
    .replace(PERSON_CORRECTION_FILLER_HE, ' ')
    .replace(/[\s,.\-–—:;!?"'()[\]]/g, '');
  return residue.length === 0 ? match : null;
}

// Icon fallback for reading an *already-written* event from before this
// changed (Roy's call: stop gatekeeping icons behind a fixed category list
// — the LLM now picks a real emoji directly per event, see
// llm.js's activity_icon). Kept only so an event written under the old
// scheme still resolves its icon correctly instead of regressing to the
// pushpin — no new write ever produces an activity_category again.
export function iconForCategory(category) {
  return ACTIVITY_CATEGORIES.find((c) => c.category === category)?.icon ?? '📌';
}

// A forced tool call still doesn't guarantee the model actually returns one
// clean emoji character rather than a stray word, an empty string, or a
// whole phrase with an emoji buried in it — validate before it ever reaches
// a real Calendar event or the dashboard. Deliberately simple rather than
// an exhaustive Unicode-sequence validator: reject anything containing a
// plain letter/digit (a strong signal it's a leftover category word, not an
// emoji), anything implausibly long for a single emoji (real ones,
// including skin-tone/ZWJ/flag sequences, are short), and anything with no
// recognizable pictographic character at all.
const EMOJI_LIKE = /\p{Extended_Pictographic}/u;
export function sanitizeActivityIcon(icon) {
  const trimmed = (icon || '').trim();
  if (!trimmed || trimmed.length > 8 || /[a-zA-Z0-9]/.test(trimmed) || !EMOJI_LIKE.test(trimmed)) {
    return '📌';
  }
  return trimmed;
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

// The Calendar `createEvent` payload for a candidate whose date AND time
// are both known. Shared by the normal write_calendar branch and the
// follow-up-answer branch (a `needs_time` event promoted once its time
// finally arrives) so the two can never drift — an earlier bug was one
// path getting end-time/duration handling that the other missed.
export function calendarPayloadFromCandidate(candidate, { familyMembers = [], timeZone = 'UTC' } = {}) {
  // A message giving an explicit end time or range ("9:00-18:00") keeps
  // that real duration instead of the 1-hour default (a real bug once had
  // "Commanders Day 9:00-18:00" landing as 9:00-10:00). An end at or before
  // the start rolls past midnight (e.g. "9pm-1am") — roll the end date
  // forward a day rather than landing before the event even starts.
  const end = candidate.end_time
    ? { date: candidate.end_time <= candidate.time ? addDays(candidate.date, 1) : candidate.date, time: candidate.end_time }
    : addOneHour(candidate.date, candidate.time);
  // Real bug: the kid dashboard re-derived "who is this event for" at read
  // time by scanning the event's title/description text for a family
  // member's literal name (dashboard.js's matchMembersToEvent) — completely
  // independent of the *actual* colorId already resolved and written here.
  // Most real titles never contain the person's name at all ("Dance class"
  // for Mia, "Dentist" for Theo), so that heuristic silently found nothing
  // and the card fell back to a neutral color even though the real Calendar
  // event was correctly colored the whole time. Fixed at the source: match
  // once here, store the same matched member's id on the event
  // (extendedProperties.private.personId), and have the dashboard read that
  // directly instead of re-guessing — one resolution, not two independent
  // ones that can drift apart.
  const matchedMember = matchSingleFamilyMember(candidate.person, familyMembers);
  return {
    title: candidate.title || 'Untitled event',
    startDateTime: `${candidate.date}T${candidate.time}:00`,
    endDateTime: `${end.date}T${end.time}:00`,
    timeZone,
    colorId: matchedMember ? hexToColorId(matchedMember.calendar_color) : DEFAULT_COLOR_ID,
    // Candidates from before these fields existed have neither — default
    // audience to 'family' (visible), never silently hide an event.
    audience: candidate.audience || 'family',
    activityIcon: candidate.activity_icon ? sanitizeActivityIcon(candidate.activity_icon) : undefined,
    personId: matchedMember?.id,
  };
}

export function formatDateTime(date, time) {
  if (!date) return '';
  if (!time) return date;
  return `${date} ${time}`;
}

// Real, repeated bug report: the confirmation kept leaving out who an
// event was actually for, even when `person` was confidently resolved —
// item 6's original version of this only stated it for the *assumed*
// (forwarded-sender-default) case, deliberately silent otherwise ("that
// case already reads fine without narration"). Wrong call — Roy's own
// live testing kept surfacing the same complaint regardless of whether the
// person came from an explicit name in the message or the forwarded-sender
// default. Now states it whenever `person` is known at all; the
// "(assumed...)" qualifier only appends for the forwarded-default case,
// same as before.
function personNote(candidate) {
  if (!candidate.person) return '';
  const assumedSuffix = candidate.personAssumed
    ? " (assumed, since you forwarded this — reply to change who it's for)"
    : '';
  return ` for ${candidate.person}${assumedSuffix}`;
}

export function confirmReply(candidate) {
  const when = formatDateTime(candidate.date, candidate.time);
  const title = candidate.title || 'Event';
  // Echo the end time back when one was given, so a duration/range being
  // correctly captured (or not) is visible in the confirmation itself,
  // not just in the Calendar event a person has to go check separately.
  const range = candidate.end_time ? `${when}–${candidate.end_time}` : when;
  return `${title}, ${range}${personNote(candidate)} — added ✅`;
}

export function qualifyReply(candidate) {
  const title = candidate.title || 'This';
  return `Got it — ${title} on ${candidate.date}${personNote(candidate)}. What time?`;
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

// Fix: reminders firing hours off from the intended time (real bug —
// "remind me to do the laundry at 22:30 today" arrived at 1:30am for a
// family in Asia/Jerusalem, UTC+3). `reminder_datetime` from the LLM is a
// naive local wall-clock value, same convention as `date`/`time` — but
// unlike those, which only ever reach Google Calendar alongside an explicit
// `timeZone` field (calendar.js's createEvent), reminder_datetime was
// inserted straight into a `timestamptz` column with no offset attached.
// Postgres/pg interpret a bare timestamp string as the *server's* zone
// (UTC on Railway), not the family's — so a reminder set for 22:30 in a
// zone ahead of UTC got stored as 22:30 UTC and fired hours later than
// intended. This converts a local wall-clock date+time to the correct UTC
// instant before it's ever persisted, using the same double-formatting
// technique as todayInTimeZone below (no timezone library — format a guess
// through Intl, measure how far off it landed, correct by that amount).
export function localDateTimeToUtcIso(dateStr, timeStr, timeZone = 'UTC') {
  const guessUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(guessUtc).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? 0 : Number(parts.hour); // some locales report midnight as "24"
  const shownAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  const offsetMs = guessUtc.getTime() - shownAsUtc;
  return new Date(guessUtc.getTime() + offsetMs).toISOString();
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
