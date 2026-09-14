// Hardcoded system commands — matched by cheap string/regex BEFORE the LLM
// is ever called. Deliberately NOT in the rules table: fixed system
// behavior ("undo" always means undo), not tunable per-family business policy.
import { todayInTimeZone, addDays, localDateTimeToUtcIso } from './classify.js';
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

// F1 (swipe-reply as an explicit context signal) — when a quoted reply's
// whole content is "cancel this" / "delete it" / "בטל", the quote already
// tells us WHICH event with certainty, so no LLM call and no A2-style
// description-matching is needed at all: it's a direct action on the
// quoted item. Deliberately strict, same "the whole message must reduce
// to this, minus a small filler vocabulary" shape as isBareTimeAnswer /
// matchBarePersonCorrection — a genuine new request that merely contains
// the word "cancel" ("cancel dance class Thursday" as a fresh, unquoted
// message) still goes through normal A2 handling, not this.
const CANCEL_WORDS_EN = /\b(cancel|cancelled|canceled|delete|deleted|remove|removed|drop|dropped|scrap|scrapped|nvm|nevermind)\b/gi;
const CANCEL_FILLER = /\b(this|it|that|the|please|one|event|thing|nvm|never|mind|no|longer|off|call|forget|actually|pls)\b/gi;
const CANCEL_WORDS_HE = /בטל(י|ו|נו)?|תבטל(י)?|לבטל|מבטל(ת)?|מחק(י|ו)?|תמחק(י)?|למחוק/g;
const CANCEL_FILLER_HE = /את|זה|זאת|ה?אירוע|בבקשה|כבר|לא|צריך|כבר לא/g;
export function isCancelIntent(text) {
  const raw = (text || '').trim();
  if (!raw) return false;
  const hasCancelWord = CANCEL_WORDS_EN.test(raw) || CANCEL_WORDS_HE.test(raw);
  CANCEL_WORDS_EN.lastIndex = 0;
  CANCEL_WORDS_HE.lastIndex = 0;
  if (!hasCancelWord) return false;
  const residue = raw
    .toLowerCase()
    .replace(CANCEL_WORDS_EN, ' ')
    .replace(CANCEL_WORDS_HE, ' ')
    .replace(CANCEL_FILLER, ' ')
    .replace(CANCEL_FILLER_HE, ' ')
    .replace(/[\s,.\-–—:;!?"'()[\]]/g, '');
  CANCEL_WORDS_EN.lastIndex = 0;
  CANCEL_WORDS_HE.lastIndex = 0;
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

// -- F2 (actionable reminders) ------------------------------------------------
// A reply to a bot-initiated reminder (a tapped button's payload, OR a
// plain typed word — not everyone taps) resolves to one of three actions.
// Closed word lists, same "the whole message must reduce to this" strict
// philosophy as isYesNoAnswer — a real new message that happens to contain
// "done" somewhere must still go through normal extraction, not get
// swallowed as a reminder action.
const DONE_WORDS = new Set(['done', 'did it', 'complete', 'completed', 'finished', 'mark done', 'mark as done', 'בוצע', 'סיימתי', 'עשיתי']);
const SNOOZE_WORDS = new Set(['snooze', 'later', 'remind me later', 'not now', 'דחה', 'דחי', 'לא עכשיו']);
const RESCHEDULE_WORDS = new Set(['reschedule', 'move it', 'change the time', 'תזיז', 'תזוזי', 'שנה מועד']);

function bareWordMatch(text, set) {
  const raw = (text || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  return set.has(raw);
}
// Snooze/Reschedule, unlike Done, can legitimately carry a target in the
// SAME reply ("snooze in an hour", "reschedule to Saturday 10am") —
// handleReminderAction's own branches already parse that inline target
// (parseSnoozeDuration / resolveReplyDate+parseCorrectedTime) when it's
// there. A strict bareWordMatch would reject the trigger itself the moment
// any target text follows it, making that inline case unreachable except
// via a button tap — a real gap, since Reschedule has no button at all
// (the live template only has Done/Snooze). Loosened to "starts with the
// trigger phrase" instead: still a closed, fixed vocabulary (never checked
// against a general incoming message — only ever reached from an
// already-routed reminder reply, quoted or parked), just no longer
// requiring the rest of the message to be empty.
function looseWordMatch(text, set) {
  const raw = (text || '').trim().toLowerCase();
  if (!raw) return false;
  for (const phrase of set) {
    if (raw === phrase || raw.startsWith(`${phrase} `)) return true;
  }
  return false;
}
export const isDoneReply = (text) => bareWordMatch(text, DONE_WORDS);
export const isSnoozeReply = (text) => looseWordMatch(text, SNOOZE_WORDS);
export const isRescheduleReply = (text) => looseWordMatch(text, RESCHEDULE_WORDS);

// A snooze duration ("in an hour", "tomorrow morning", "next week") ->
// a real UTC instant, or null if the text names no recognizable duration.
// Deliberately a short, fixed phrase table, not a general NLP date parser
// — same "narrow, not a general parser" scope as parseCorrectedTime.
export function parseSnoozeDuration(text, nowUtcIso, timeZone = 'UTC') {
  const raw = (text || '').trim().toLowerCase();
  const now = new Date(nowUtcIso).getTime();

  const hoursMatch = raw.match(/\bin\s+(an?|\d+)\s*hours?\b/);
  if (hoursMatch) {
    const n = /^an?$/.test(hoursMatch[1]) ? 1 : parseInt(hoursMatch[1], 10);
    return new Date(now + n * 60 * 60 * 1000).toISOString();
  }
  const minutesMatch = raw.match(/\bin\s+(\d+)\s*min(?:ute)?s?\b/);
  if (minutesMatch) return new Date(now + parseInt(minutesMatch[1], 10) * 60 * 1000).toISOString();

  const today = todayInTimeZone(timeZone);
  if (/\btomorrow morning\b/.test(raw)) return localDateTimeToUtcIso(addDays(today, 1), '09:00', timeZone);
  if (/\btomorrow\b/.test(raw)) return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  if (/\btonight\b/.test(raw)) {
    const tonight = localDateTimeToUtcIso(today, '20:00', timeZone);
    return new Date(tonight).getTime() > now ? tonight : localDateTimeToUtcIso(addDays(today, 1), '20:00', timeZone);
  }
  if (/\bnext week\b/.test(raw)) return new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  return null;
}
