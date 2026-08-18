// Deterministic app code acting on the LLM's structured output — the LLM
// never decides routing, only reports fields. See rules/defaultRules.js for
// the actual branching logic (data, not code); this module just turns a
// candidate into the facts those rules evaluate, and turns a matched action
// into human copy / calendar payloads.

export function factsFromCandidate(candidate) {
  const hasDate = candidate.date != null && candidate.date !== '';
  const hasTime = candidate.time != null && candidate.time !== '';
  const contentFields = ['title', 'date', 'time', 'person', 'category'];
  const hasAnyField = contentFields.some((f) => candidate[f] != null && candidate[f] !== '');
  return { hasDate, hasTime, hasAnyField };
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
