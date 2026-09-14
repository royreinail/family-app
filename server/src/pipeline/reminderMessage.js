// F2 (actionable reminders, enhancement backlog v2) — the single source of
// truth for a fired reminder's structure. Both delivery paths are thin
// adapters over this one shape:
//   - free-form interactive message  — allowed inside WhatsApp's 24h
//     customer-service window, no template approval
//   - approved template with quick-reply buttons — required outside it
//     (the 20:00 daily reminder often falls outside if neither parent
//     messaged that day)
// Per the backlog's explicit rule: "Do not write the reminder layout
// twice." Same single-source-of-truth rule already applied to the frontend
// (shared calculations live in one module). Add a test asserting both
// renderers produce the same button set for the same reminder record.
//
// Roy's live edit to the reminder_notification template added exactly two
// quick-reply buttons — "Done" and "Snooze" — not the three the doc
// sketched. "Reschedule" stays a supported action, but via a plain text
// reply ("reschedule to Friday"), not a tap-target, so both paths render
// the same two buttons.

export const REMINDER_BUTTONS = [
  { id: 'reminder_done', title: 'Done' },
  { id: 'reminder_snooze', title: 'Snooze' },
];

// Must match the approved template's fixed copy EXACTLY, or the two paths
// won't render identically. Approved template body:
//   "⏰ {{reminder_text}} — sent by your Family App assistant."
// The template bakes this wrapper in and takes only {{reminder_text}} at
// send time; the free-form path has to reproduce it, so it lives here once.
export function reminderBodyText(innerText) {
  return `⏰ ${innerText} — sent by your Family App assistant.`;
}

/**
 * @param {{title: string}} task
 * @returns {{innerText: string, bodyText: string, buttons: {id: string, title: string}[]}}
 *   innerText  — the value for the template's {{reminder_text}} variable
 *   bodyText   — the fully rendered body, for the free-form path
 *   buttons    — identical for both paths
 */
export function composeReminderMessage(task) {
  // task.title is already "Reminder: <thing>" (scheduleReminder builds that
  // prefix), matching the approved template's own example value.
  return {
    innerText: task.title,
    bodyText: reminderBodyText(task.title),
    buttons: REMINDER_BUTTONS,
  };
}
