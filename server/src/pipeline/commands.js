// Hardcoded system commands — matched by cheap string/regex BEFORE the LLM
// is ever called. Deliberately NOT in the rules table: fixed system
// behavior ("undo" always means undo), not tunable per-family business policy.
const HELP_TEXT =
  "Here's what I understand:\n" +
  '• Forward a message, photo, or email — I\'ll try to add it to the calendar or tasks.\n' +
  '• "undo" — reverts the last thing I added for you.\n' +
  '• "list tasks" — shows the current task list.\n' +
  '• Reply to one of my confirmations with a correction (e.g. "no, 5pm") to fix it.\n' +
  '• Tell me a standing rule ("art therapy is always at the Rothschild clinic") and I\'ll ask to confirm, then remember it.\n' +
  '• "rules" — shows the standing rules I currently apply; "delete rule N" removes one.';

// C1 — "show my rules" / "my rules" / "list rules", matched the cheap way
// every other command is (before the LLM, before gate rules) since this is
// fixed system behavior, not business policy.
const RULES_COMMAND = /^(show|list)?\s*(my )?rules$/i;
// "delete rule 2" / "forget rule 2" / "remove rule 2" — the index refers to
// the numbering `formatRulesList` just showed (same "numbered list, pick by
// index" convention as A2's disambiguation reply).
const DELETE_RULE_COMMAND = /^(forget|delete|remove) rule (\d+)$/i;

export function matchCommand(text) {
  const trimmed = (text || '').trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'undo') return 'undo';
  if (lower === 'list tasks') return 'list_tasks';
  if (lower === 'help') return 'help';
  if (RULES_COMMAND.test(lower)) return 'list_rules';
  const deleteMatch = trimmed.match(DELETE_RULE_COMMAND);
  if (deleteMatch) return { type: 'delete_rule', index: parseInt(deleteMatch[2], 10) };
  return null;
}

// C1 (D-3) — resolves the yes/no reply to a pending standing-rule proposal
// *without* a second LLM call, per D-3's explicit efficiency requirement:
// match the bare reply directly against the pending record. Deliberately a
// closed word list, not a free-text-intent judgment (that would be exactly
// the "second LLM call" this exists to avoid) — a message that doesn't
// reduce to one of these exact words isn't treated as an answer at all, and
// falls through to normal extraction untouched.
const YES_WORDS = new Set(['yes', 'y', 'yeah', 'yep', 'yea', 'sure', 'ok', 'okay', 'correct', 'confirm', 'confirmed', 'נכון', 'כן', 'בטח', 'אישור']);
const NO_WORDS = new Set(['no', 'n', 'nope', 'nah', 'cancel', 'לא', 'ביטול']);
export function isYesNoAnswer(text) {
  const raw = (text || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  if (YES_WORDS.has(raw)) return 'yes';
  if (NO_WORDS.has(raw)) return 'no';
  return null;
}

export function helpReply() {
  return HELP_TEXT;
}

export function formatTaskList(tasks) {
  if (tasks.length === 0) return 'No tasks yet.';
  const lines = tasks.map((t) => {
    const due = t.due_date ? ` (due ${t.due_date instanceof Date ? t.due_date.toISOString().slice(0, 10) : t.due_date})` : '';
    const status = t.status === 'done' ? '✅ ' : '';
    return `${status}${t.title}${due}`;
  });
  return ['Current tasks:', ...lines].join('\n');
}

// Very small, deliberately narrow time parser for correction replies like
// "no, 5pm" / "actually 5:30pm" / "17:00". Not a general NLP date parser —
// the correction path only ever needs to update one field at a time.
export function parseCorrectedTime(text) {
  const match = (text || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let [, hourStr, minuteStr, meridiem] = match;
  let hour = parseInt(hourStr, 10);
  const minute = minuteStr ? parseInt(minuteStr, 10) : 0;
  if (meridiem) {
    const isPM = meridiem.toLowerCase() === 'pm';
    if (isPM && hour < 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// Same follow-up-answer reply ("8:30-18:00", "8:30 to 6pm") but captures a
// second time when the answer gives a real range, not just a start — real
// bug: a range answer to "What time?" silently kept only the start time,
// the same duration-loss bug item 1 fixed for the *initial* message, just
// never carried over to the follow-up-answer merge path. Looks for a second
// time-shaped match after the first one ends; a single "8:30" still yields
// endTime: null exactly as before.
export function parseCorrectedTimeRange(text) {
  const raw = text || '';
  const time = parseCorrectedTime(raw);
  if (!time) return { time: null, endTime: null };
  const firstMatch = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const rest = raw.slice(firstMatch.index + firstMatch[0].length);
  const endTime = parseCorrectedTime(rest);
  return { time, endTime: endTime && endTime !== time ? endTime : null };
}

// True when the whole message is just an answer to the bot's "What time?"
// follow-up — "8:30", "at 8:30am", "8:30 בבוקר" — and nothing else. Used to
// decide whether an incoming message should be merged into a parked
// `needs_time` event (keeping its title/date/person) rather than parsed
// fresh. Deliberately strict: a standalone request that merely contains a
// time ("Dentist tomorrow 9am") must still go through normal extraction, so
// anything left over after removing the time and a small filler vocabulary
// disqualifies it.
export function isBareTimeAnswer(text) {
  const raw = (text || '').trim();
  if (!raw || !parseCorrectedTime(raw)) return false;
  const residue = raw
    .replace(/\d{1,2}(?::\d{2})?/g, ' ') // the digits of the time itself
    .replace(/\b[ap]\.?m\.?\b/gi, ' ') // am / pm / a.m. / p.m.
    .replace(
      /\b(at|around|about|approx|by|from|to|until|till|through|starts?|start|end|ends|time|in|the|on|o'?clock|morning|afternoon|evening|noon|midday|midnight|tonight|today)\b/gi,
      ' '
    )
    .replace(/בשעה|בבוקר|בבקר|אחה"?צ|בצהריי?ם|בערב|בלילה|בסביבות|בערך|עד|ב['׳]?/g, ' ') // common Hebrew time filler, incl. "until"
    .replace(/[\s,.\-–—:;!?"'()[\]]/g, '');
  return residue.length === 0;
}

// A2 (cancel/reschedule) — resolves a disambiguation prompt ("which one?
// 1. Dance class 16:00  2. Dance rehearsal 18:00") the same strict way
// isBareTimeAnswer resolves a "What time?" prompt: the whole message must
// reduce to just the number picked (optionally with "number"/"#"/a
// trailing period), or a standalone new request that happens to contain a
// digit somewhere would get misread as picking an option. Returns the
// picked 1-based index, or null if the message isn't a clean bare number.
export function bareDisambiguationChoice(text) {
  const raw = (text || '').trim();
  const match = raw.match(/^(?:#|number|no\.?|option)?\s*(\d{1,2})\.?$/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return n >= 1 ? n : null;
}
