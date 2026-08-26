import { getPool } from '../db/pool.js';
import { ACTIVITY_CATEGORIES } from '../integrations/activityCategories.js';

// Derived from the canonical category list (single source of truth — see
// activityCategories.js), not hand-duplicated: one {keyword, icon} row per
// keyword. Per architecture doc ("starts as a short hardcoded list,
// editable later"). Keyword matching is case-insensitive substring match
// against the extracted title/category — English only, by construction;
// see classify.js's iconForCategory for the language-agnostic fallback.
export const DEFAULT_ICONS = ACTIVITY_CATEGORIES.flatMap(({ icon, keywords }) =>
  keywords.map((keyword) => ({ keyword, icon }))
);

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

// Returns null on no match (not a fallback icon) — the caller (dashboard.js)
// decides what to fall back to, since there's now a second, better fallback
// available (the LLM's own activity_category classification) before ever
// reaching the true last-resort pushpin.
export function resolveIcon(icons, text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const match = icons.find((i) => lower.includes(i.keyword.toLowerCase()));
  return match?.icon ?? null;
}
