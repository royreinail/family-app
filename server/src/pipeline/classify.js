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
