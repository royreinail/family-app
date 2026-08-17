import { getPool } from '../db/pool.js';

// Short hardcoded seed list per architecture doc ("starts as a short
// hardcoded list, editable later"). Keyword matching is case-insensitive
// substring match against the extracted title/category.
export const DEFAULT_ICONS = [
  { keyword: 'school', icon: '🎒' },
  { keyword: 'doctor', icon: '🩺' },
  { keyword: 'dentist', icon: '🦷' },
  { keyword: 'dance', icon: '💃' },
  { keyword: 'soccer', icon: '⚽' },
  { keyword: 'football', icon: '⚽' },
  { keyword: 'birthday', icon: '🎉' },
  { keyword: 'playdate', icon: '🧸' },
  { keyword: 'swim', icon: '🏊' },
  { keyword: 'music', icon: '🎵' },
  { keyword: 'piano', icon: '🎹' },
  { keyword: 'art', icon: '🎨' },
  { keyword: 'pickup', icon: '🚗' },
  { keyword: 'gym', icon: '🤸' },
];

export async function findAllForFamily(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from activity_icons where family_id = $1 and deleted_at is null`,
    [familyId]
  );
  return rows;
}

export async function seedDefaults(familyId, pool = getPool()) {
  for (const { keyword, icon } of DEFAULT_ICONS) {
    await pool.query(
      `insert into activity_icons (family_id, keyword, icon) values ($1,$2,$3)`,
      [familyId, keyword, icon]
    );
  }
}

export function resolveIcon(icons, text) {
  if (!text) return '📌';
  const lower = text.toLowerCase();
  const match = icons.find((i) => lower.includes(i.keyword.toLowerCase()));
  return match?.icon ?? '📌';
}
