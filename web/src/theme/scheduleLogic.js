// Shared calculations used by both the kid dashboard today and the parent
// view once it exists in Phase 2 (frontend guardrail 1) — icon/color lookup
// per family member, time formatting, and the dashboard item cap all live
// here exactly once.
import { color, KID_DASHBOARD_ITEM_CAP } from './tokens.js';

/** Caps a sorted event list to the dashboard's visible-item limit. */
export function capItems(events, cap = KID_DASHBOARD_ITEM_CAP) {
  return events.slice(0, cap);
}

/** "16:00" or an ISO datetime -> "4:00 pm". Returns '' for all-day/no time. */
export function formatTime(value) {
  if (!value) return '';
  const date = value.length <= 5 ? new Date(`1970-01-01T${value}:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const meridiem = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  const minuteStr = minutes === 0 ? '00' : String(minutes).padStart(2, '0');
  return `${hours}:${minuteStr} ${meridiem}`;
}

/** Family-member id -> calendar_color, single lookup used everywhere a card needs a color. */
export function colorForMember(memberId, members) {
  return members.find((m) => m.id === memberId)?.calendar_color ?? color.neutralCard;
}

/**
 * Card background rule (architecture doc, kid dashboard section):
 *  - 0 or 1 participant matched -> solid color (or neutral if unmatched)
 *  - exactly 2 -> 2-color diagonal stripe
 *  - 3+ -> neutral background + small icon/avatar stack instead of striping
 */
export function cardBackground(memberIds, members) {
  const colors = memberIds.map((id) => colorForMember(id, members));
  if (colors.length === 0) {
    return { type: 'neutral' };
  }
  if (colors.length === 1) {
    return { type: 'solid', color: colors[0] };
  }
  if (colors.length === 2) {
    return { type: 'stripe', colors };
  }
  return { type: 'neutral-stack', memberIds: memberIds.slice(0, 3) };
}
