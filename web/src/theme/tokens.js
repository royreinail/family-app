// Single source of truth for colors, spacing, radii, type and shadows —
// imported everywhere (frontend guardrail 5). Values are lifted directly
// from the approved Claude Design mocks (Tomorrow Board / Settings Home /
// Onboarding Flow) so the kid dashboard, Settings Home, and onboarding stay
// visually one system rather than three that merely resemble each other.

export const color = {
  // page / surface
  page: '#efe9df',
  surface: '#faf5ec',
  surfaceInset: '#f4efe6',
  white: '#ffffff',

  // ink (text), expressed as rgba so callers can still layer opacity via
  // the *Alpha helpers below when a mock calls for e.g. ".48"
  ink: '#3a3128',
  inkRgb: '58,49,40',

  // person / activity palette (assignable to family members, cycled in order)
  personPurple: '#b3a3d9',
  personApricot: '#e6ab84',
  personSage: '#a3bf9a',
  personPink: '#e2b6c4',
  personTeal: '#8fc4c0',
  personGold: '#f0cf8e',

  // day boundary + night
  sun: '#e8a33d',
  night: '#3f3550',
  nightIcon: '#e8d9a8',
  neutralCard: '#e4ddcd',
  neutralIcon: '#9c9280',

  // accent families: [text/icon, tint background]
  accentSettings: '#6b58a6',
  accentSettingsTint: '#efe6f4',
  accentTimezone: '#c98a2c',
  accentTimezoneTint: '#f7ecd6',
  accentWhatsapp: '#25963f',
  accentWhatsappTint: '#e7f7ed',
  accentCalendar: '#4a7fae',
  accentCalendarTint: '#e9eefb',
};

export function ink(alpha) {
  return `rgba(${color.inkRgb},${alpha})`;
}

// The assignable family-member color picker — deliberately Google
// Calendar's own 11 event colors (colorId 1-11, same order), not a
// standalone palette that merely looks similar. This is what makes "the
// kid dashboard card is purple" and "the Calendar event is purple" the
// same claim rather than a coincidence — see server/src/integrations/
// googleColors.js, which must stay in sync with this list value-for-value.
// (color.personPurple/personApricot/personSage above are unrelated —
// those are the app's own generic UI accent tokens for buttons/icons/
// progress dots, not tied to any family member's identity.)
export const personPalette = [
  '#7986cb', // Lavender
  '#33b679', // Sage
  '#8e24aa', // Grape
  '#e67c73', // Flamingo
  '#f6c026', // Banana
  '#f5511d', // Tangerine
  '#039be5', // Peacock
  '#616161', // Graphite
  '#3f51b5', // Blueberry
  '#0b8043', // Basil
  '#d60000', // Tomato
];

// The curated subset actually offered in the family-member color picker
// (Roy's call, live-testing feedback: the full 11 reads too "busy"/harsh on
// the calendar itself). `personPalette` above stays the complete, unedited
// 11 — it's still the authoritative hex<->colorId source (an existing
// member assigned Grape or Tomato before this still resolves correctly;
// only *new* picks are steered toward the calmer set). Drops Grape (vivid
// magenta-purple), Peacock (vivid blue), Tomato (bright red) as the
// boldest three, and Graphite — already reserved as the "no match/shared"
// default color (resolveEventColorId's fallback), so offering it as a
// deliberate personal choice would be confusing right alongside that
// meaning. Keeps Tangerine (warm orange, not harsh) since it's already a
// real family member's identity color.
export const personPickerColors = personPalette.filter(
  (c) => !['#8e24aa', '#039be5', '#616161', '#d60000'].includes(c)
);

export const kidIconChoices = ['🦄', '🚀', '⚽', '🐢', '🌸', '🐳', '🎨', '🦋'];

export const font = {
  family: "Nunito, system-ui, sans-serif",
  icon: "'Material Symbols Rounded'",
  emoji: "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif",
};

export const weight = { regular: 400, semibold: 600, bold: 700, heavy: 800 };

export const radius = {
  sm: 14,
  md: 18,
  lg: 22,
  xl: 26,
  xxl: 28,
  pill: 32,
  round: '50%',
  card: 34, // outer phone-frame radius used across onboarding/settings mocks
};

export const spacing = {
  xxs: 4,
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 44,
};

export const shadow = {
  card: `0 2px 8px ${ink(0.07)}`,
  cardSoft: `0 2px 6px ${ink(0.06)}`,
  raised: `0 3px 12px ${ink(0.1)}`,
  buttonTint: (rgb) => `0 3px 10px rgba(${rgb},.28)`,
};

// The 4-5 item cap for the kid dashboard (design principle: cap visible
// items, never a dense full-day listing). Wake-up/bedtime bookends don't
// count toward this — they're day boundaries, not activities.
export const KID_DASHBOARD_ITEM_CAP = 5;

export const theme = { color, ink, personPalette, personPickerColors, kidIconChoices, font, weight, radius, spacing, shadow, KID_DASHBOARD_ITEM_CAP };
export default theme;
