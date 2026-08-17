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
