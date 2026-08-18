// Google Calendar only accepts an event's color from its own fixed palette
// (the `colorId` field, 1-11) — there's no way to send an arbitrary hex to
// the Calendar API. So our own "assignable person color" palette (see
// web/src/theme/tokens.js's personPalette, which must list these same 11
// hex values in this same order) has to BE this palette, not something
// visually close to it, or "same color in our UI and in Calendar" would be
// a lie. Values are Google's own documented Calendar event colors.
export const GOOGLE_EVENT_COLORS = [
  { colorId: '1', name: 'Lavender', hex: '#7986cb' },
  { colorId: '2', name: 'Sage', hex: '#33b679' },
  { colorId: '3', name: 'Grape', hex: '#8e24aa' },
  { colorId: '4', name: 'Flamingo', hex: '#e67c73' },
  { colorId: '5', name: 'Banana', hex: '#f6c026' },
  { colorId: '6', name: 'Tangerine', hex: '#f5511d' },
  { colorId: '7', name: 'Peacock', hex: '#039be5' },
  { colorId: '8', name: 'Graphite', hex: '#616161' },
  { colorId: '9', name: 'Blueberry', hex: '#3f51b5' },
  { colorId: '10', name: 'Basil', hex: '#0b8043' },
  { colorId: '11', name: 'Tomato', hex: '#d60000' },
];

// Used when an event involves more than one person, or the extracted
// `person` doesn't match any known family member — a neutral, deliberate
// default rather than guessing. Graphite reads as "shared/unassigned"
// rather than looking like anyone's personal color.
export const DEFAULT_COLOR_ID = '8';

export function hexToColorId(hex) {
  const match = GOOGLE_EVENT_COLORS.find((c) => c.hex.toLowerCase() === (hex || '').toLowerCase());
  return match?.colorId ?? DEFAULT_COLOR_ID;
}
