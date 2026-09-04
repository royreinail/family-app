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
const PERSON_CORRECTION_FILLER =
  /\b(for|actually|it's|its|it|change|to|that's|thats|instead|please|not|this|is|assign|assigned|reassign|make|should|switch|set)\b/gi;
const PERSON_CORRECTION_FILLER_HE = /עבור|במקום|זה|זאת|בשביל|תשני|תשנה|לא|בעצם/g;
// Real bug (item 9): Hebrew commonly attaches a one-letter preposition
// directly to a name with no space at all — "לגאיה" ("to Gaia") is one
// token, ל + גאיה. matchSingleFamilyMember still finds "גאיה" as a
// substring, but stripping just that substring from "לגאיה" leaves a
// single leftover letter ("ל") that isn't in either filler list and isn't
// punctuation — the residue check used to fail on exactly the kind of
// bare reply a Hebrew-speaking user would naturally send, which is very
// plausibly why "regardless of whether the correction is sent as a quoted
// reply or a plain follow-up message" it "doesn't work" for Hebrew replies.
const HEBREW_PREFIX_LETTERS = 'לבמהוכש';
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
  const isJustHebrewPrefix = residue.length === 1 && HEBREW_PREFIX_LETTERS.includes(residue);
  return residue.length === 0 || isJustHebrewPrefix ? match : null;
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

// C1 (standing rules taught in conversation) — applies any active
// 'event_default' standing rule whose match_keyword appears in this
// message (title or raw text), filling in only fields the extraction
// itself left empty. Deliberately a *default*, never a silent override: if
// the message already stated a location/audience/person, that stands — a
// taught rule is a fallback for when the sender didn't say otherwise, the
// same relationship the LLM's own 'family' audience default already has to
// an explicit audience read. `duration_minutes` has no direct field on a
// capture candidate (only an optional end_time) — stashed as
// `ruleDurationMinutes` and only consulted by calendarPayloadFromCandidate
// when the message gave no explicit end_time/range of its own.
export function applyStandingRuleDefaults(candidate, rawInput, rules) {
  if (!rules?.length) return candidate;
  const haystack = `${rawInput || ''} ${candidate.title || ''}`.toLowerCase();
  let result = candidate;
  for (const rule of rules) {
    if (!rule.match_keyword || !haystack.includes(rule.match_keyword.toLowerCase())) continue;
    if (rule.field === 'location' && !result.location) result = { ...result, location: rule.value };
    else if (rule.field === 'audience' && !result.audience) result = { ...result, audience: rule.value };
    else if (rule.field === 'person' && !result.person) result = { ...result, person: rule.value };
    else if (rule.field === 'duration_minutes' && !result.end_time && !result.ruleDurationMinutes) {
      result = { ...result, ruleDurationMinutes: Number(rule.value) };
    }
  }
  return result;
}

// C1 — "show my rules" / "delete rule N". Numbered the same way as every
// other numbered-list-then-pick-by-index reply in this codebase (A2's
// disambiguation) so "delete rule 2" means exactly what was just shown.
export function formatRulesList(rules) {
  if (!rules?.length) {
    return 'No standing rules yet — tell me something like "art therapy is always at the Rothschild clinic" and I\'ll ask to remember it.';
  }
  const lines = rules.map((r, i) => `${i + 1}. ${r.rule_text}`);
  return ['Your standing rules:', ...lines, '(reply "delete rule N" to remove one)'].join('\n');
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
  // Compare only date+hour+minute ("YYYY-MM-DDTHH:MM"), not a raw string
  // prefix of the full reminder_datetime — the LLM's ISO output can carry
  // seconds or other trailing formatting a strict prefix match would trip
  // over even when the two values plainly describe the same moment.
  return candidate.reminder_datetime.slice(0, 16) === `${candidate.date}T${candidate.time}`;
}

// B2 (recurring events) — Google Calendar's own RRULE, generated from the
// LLM's simple {weekly|biweekly|monthly|null} classification rather than
// asking the model to produce RFC 5545 syntax itself (a much easier thing
// to get subtly wrong than picking one of three words). No UNTIL/COUNT —
// runs indefinitely, same as any manually-created recurring Calendar event
// until someone cancels it (A2's cancel, which naturally still works on one
// occurrence at a time: Google's own listEvents(singleEvents: true) already
// expands a recurring event into individual instances with their own
// deletable ids, so nothing extra was needed there for this to compose).
const RRULE_BY_RECURRENCE = {
  weekly: 'RRULE:FREQ=WEEKLY',
  biweekly: 'RRULE:FREQ=WEEKLY;INTERVAL=2',
  monthly: 'RRULE:FREQ=MONTHLY',
};
export function buildRecurrenceRule(recurrence) {
  const rule = RRULE_BY_RECURRENCE[recurrence];
  return rule ? [rule] : undefined;
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
  // C1's duration_minutes standing-rule default ("therapy sessions are
  // always 50 minutes") only ever fills a gap the message itself left open
  // — an explicit end_time/range always wins, checked first exactly like
  // every other standing-rule field.
  const end = candidate.end_time
    ? { date: candidate.end_time <= candidate.time ? addDays(candidate.date, 1) : candidate.date, time: candidate.end_time }
    : candidate.ruleDurationMinutes
      ? addMinutes(candidate.date, candidate.time, candidate.ruleDurationMinutes)
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
    // B1/B2 — plain pass-through; calendar.js's createEvent is the only
    // place either one is actually interpreted (native `location` field,
    // RRULE array respectively).
    location: candidate.location || undefined,
    recurrence: buildRecurrenceRule(candidate.recurrence),
  };
}

// A3 (multi-event extraction) — one line per additional event found beyond
// the primary one, sent as its own follow-up message right after the
// primary confirmation (see pipeline.js) rather than folded into
// confirmReply itself — keeps every existing single-event confirmReply call
// site and test untouched. `needs_time` items were written as a tentative
// task (same routing a date-only *primary* message already gets), not
// dropped — said explicitly here so it's visible which ones still need a
// time, the same "never silently lose it" reasoning A3 exists for at all.
export function formatAdditionalEventsNote(items) {
  if (!items?.length) return '';
  const lines = items.map(({ status, candidate }) => {
    const when = formatDateTime(candidate.date, candidate.time);
    const suffix = status === 'needs_time' ? ' — needs a time (added as a task)' : ' — added ✅';
    return `• ${candidate.title || 'Event'}${when ? `, ${when}` : ''}${personNote(candidate)}${suffix}`;
  });
  return `Also found ${items.length} more in that message:\n${lines.join('\n')}`;
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

// Item 10 — a real event that *also* carries a separately-requested
// reminder (fixture 7's shape: "remind me to pack the gym bag Thursday
// night, gym class is Friday 9am") used to confirm with zero mention that
// a reminder was scheduled at all — pipeline.js calls scheduleReminder
// right after sending this reply, but nothing in the reply said so. Only
// relevant here: the *pure*-reminder case (isPureReminder) routes to
// reminderConfirmReply instead, which already states it explicitly, so
// there's no risk of double-mentioning the same reminder.
function reminderNote(candidate) {
  if (!candidate.reminder_requested || !candidate.reminder_datetime) return '';
  return ` (I'll also remind you at ${candidate.reminder_datetime.slice(11, 16)})`;
}

// B1 — states the captured location back, same "confirm what was actually
// understood" reasoning as personNote/reminderNote: a wrong or missing
// location should be visible in the confirmation itself, not discovered
// only by opening the real Calendar event later.
function locationNote(candidate) {
  return candidate.location ? ` at ${candidate.location}` : '';
}

// B2 — states that this is a *repeating* commitment, not a one-off, so a
// recurrence being correctly captured (or wrongly assumed) is visible at a
// glance the same way a range being captured is (see confirmReply's own
// `range` line above).
const RECURRENCE_LABEL = { weekly: 'weekly', biweekly: 'every two weeks', monthly: 'monthly' };
function recurrenceNote(candidate) {
  const label = RECURRENCE_LABEL[candidate.recurrence];
  return label ? ` (repeats ${label})` : '';
}

export function confirmReply(candidate) {
  const when = formatDateTime(candidate.date, candidate.time);
  const title = candidate.title || 'Event';
  // Echo the end time back when one was given, so a duration/range being
  // correctly captured (or not) is visible in the confirmation itself,
  // not just in the Calendar event a person has to go check separately.
  const range = candidate.end_time ? `${when}–${candidate.end_time}` : when;
  return `${title}, ${range}${locationNote(candidate)}${personNote(candidate)}${recurrenceNote(candidate)}${reminderNote(candidate)} — added ✅`;
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

// A1 (read-back queries) — pulls just the HH:MM out of a real Calendar
// event's ISO start time; an all-day event (date only, no dateTime) has no
// specific time to show at all.
function formatEventLine(item) {
  const time = item.start?.dateTime ? ` ${item.start.dateTime.slice(11, 16)}` : '';
  return `• ${item.summary || 'Untitled'}${time}`;
}

export function formatQueryReply(events, { personName, dateFrom, dateTo } = {}) {
  const scope = personName ? ` for ${personName}` : '';
  const range = dateFrom === dateTo ? dateFrom : `${dateFrom} to ${dateTo}`;
  if (!events.length) {
    return `Nothing on the calendar${scope}, ${range}.`;
  }
  return `Here's what's on${scope}, ${range}:\n${events.map(formatEventLine).join('\n')}`;
}

// A2 (cancel/reschedule) — matches a free-text description ("dance class",
// "the dentist thing") against real Calendar events by word overlap in the
// title, not an exact/substring match: real descriptions rarely repeat the
// title verbatim, and titles/descriptions can each be in either language.
// Deliberately simple (split on whitespace/punctuation, any shared word of
// real length counts) rather than fuzzy-scored — good enough for a small
// personal calendar's realistic candidate set, and its behavior stays
// obvious to reason about. `dateHint`, when given, requires an exact same-day
// match — no partial-credit for "close" dates, since a wrong-day cancel is
// exactly the kind of mistake this whole flow exists to prevent.
function significantWords(text) {
  return (text || '')
    .toLowerCase()
    .split(/[\s,.\-–—:;!?"'()[\]]+/)
    .filter((w) => w.length > 1);
}

export function matchEventsByDescription(events, { titleHint, dateHint } = {}) {
  const hintWords = significantWords(titleHint);
  return events.filter((item) => {
    if (dateHint) {
      const itemDate = (item.start?.dateTime || item.start?.date || '').slice(0, 10);
      if (itemDate !== dateHint) return false;
    }
    if (!hintWords.length) return true; // date-only request ("cancel Thursday's thing") with no title text to match
    const titleWords = new Set(significantWords(item.summary));
    return hintWords.some((w) => titleWords.has(w));
  });
}

function formatCandidateLine(item, index) {
  const date = (item.start?.dateTime || item.start?.date || '').slice(0, 10);
  const time = item.start?.dateTime ? ` ${item.start.dateTime.slice(11, 16)}` : '';
  return `${index + 1}. ${item.summary || 'Untitled'}, ${date}${time}`;
}

export function formatDisambiguationReply(candidates, managementAction) {
  const verb = managementAction === 'cancel' ? 'cancel' : 'reschedule';
  return `A few things match — which one do you want to ${verb}?\n${candidates.map(formatCandidateLine).join('\n')}\n(reply with the number)`;
}

export function formatNoMatchReply(titleHint) {
  return `I couldn't find anything on the calendar matching "${titleHint}".`;
}

export function formatManagementConfirmReply(managementAction, item, { newDate, newTime } = {}) {
  const title = item.summary || 'that';
  if (managementAction === 'cancel') {
    return `Cancelled — ${title} ✅`;
  }
  return `Moved — ${title} to ${newDate} ${newTime} ✅`;
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

// A2 (reschedule) — same "UTC as neutral scratch space" reasoning as
// addOneHour just above, generalized to an arbitrary naive
// "YYYY-MM-DDTHH:MM[:SS]" string and an arbitrary duration. Exists
// specifically because `new Date(naiveString)` parses using the *server
// process's* local timezone, not a neutral one — real bug caught writing
// this: computing a rescheduled event's new end time by round-tripping
// through plain `new Date()` + `.toISOString()` silently shifted every
// result by the sandbox's local UTC offset, landing hours off. Never use
// `new Date()` directly on a naive wall-clock string in this codebase —
// this pair (or addOneHour, or localDateTimeToUtcIso for a real instant)
// is why.
export function naiveDateTimeToUtcMs(str) {
  const [datePart, timePart = '00:00:00'] = str.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second = 0] = timePart.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

// C1 (duration_minutes standing-rule default) — same naive-wall-clock-safe
// reasoning as naiveDateTimeToUtcMs/utcMsToNaiveDateTime just below (which
// this is built directly on top of, rather than a fresh `new Date()` +
// arithmetic that would reintroduce the exact server-local-timezone bug
// those two exist to prevent), generalized to an arbitrary minute offset.
export function addMinutes(dateStr, timeStr, minutes) {
  const ms = naiveDateTimeToUtcMs(`${dateStr}T${timeStr}:00`) + minutes * 60 * 1000;
  const naive = utcMsToNaiveDateTime(ms);
  return { date: naive.slice(0, 10), time: naive.slice(11, 16) };
}

export function utcMsToNaiveDateTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
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

// Moved here from dashboard.js (A1, read-back queries) so pipeline.js can
// reuse it for person-scoped queries ("what does Gaia have Tuesday?")
// without routes/ depending on pipeline/ backwards — classify.js is the
// shared pure-logic module both already sit on top of. Real bug this fixed
// originally: this used to be the *only* signal for "who is this event
// for" — scanning the event's title/description text for a family
// member's literal name, independent of, and much less reliable than, the
// actual match already made and colored at write time
// (calendarPayloadFromCandidate above). Most real titles never contain the
// person's name at all ("Dance class" for Mia), so that heuristic found
// nothing and the card fell back to a neutral color even though the real
// Calendar event was correctly colored the whole time. Now prefers the
// member actually stored on the event (extendedProperties.private.personId,
// the same match colorId came from — one resolution, not two that can
// drift), unioned with any *additional* members the text happens to name
// (preserves the 2-person stripe / 3+ avatar-stack display for a message
// that genuinely mentions more than one person — the extraction pipeline
// only ever resolves one `person` field, so text-matching is still the
// only way to catch a second one). An event written before this existed
// has no personId at all and falls back to the text-only heuristic
// exactly as before.
export function matchMembersToEvent(item, members) {
  const personId = item.extendedProperties?.private?.personId;
  const storedMember = personId ? members.find((m) => m.id === personId) : null;
  const haystack = `${item.summary || ''} ${item.description || ''}`.toLowerCase();
  const textMatches = members.filter((m) => haystack.includes(m.name.toLowerCase()));
  if (!storedMember) return textMatches;
  return [storedMember, ...textMatches.filter((m) => m.id !== storedMember.id)];
}
