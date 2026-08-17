// Hardcoded system commands — matched by cheap string/regex BEFORE the LLM
// is ever called. Deliberately NOT in the rules table: fixed system
// behavior ("undo" always means undo), not tunable per-family business policy.
const HELP_TEXT =
  "Here's what I understand:\n" +
  '• Forward a message, photo, or email — I\'ll try to add it to the calendar or tasks.\n' +
  '• "undo" — reverts the last thing I added for you.\n' +
  '• "list tasks" — shows the current task list.\n' +
  '• Reply to one of my confirmations with a correction (e.g. "no, 5pm") to fix it.';

export function matchCommand(text) {
  const trimmed = (text || '').trim().toLowerCase();
  if (trimmed === 'undo') return 'undo';
  if (trimmed === 'list tasks') return 'list_tasks';
  if (trimmed === 'help') return 'help';
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
