// Canonical activity categories — single source of truth for icon
// selection, used two ways:
//   1. repositories/activityIcons.js seeds these as per-family
//      {keyword, icon} rows for free, deterministic English-title matching
//      (resolveIcon) — the fast path, no LLM involved.
//   2. integrations/llm.js asks the LLM to classify every extraction into
//      one of these category names directly, which works in any language
//      and doesn't depend on an English keyword appearing in the title at
//      all — used as the fallback when no keyword matches
//      (pipeline/classify.js's iconForCategory).
// Same category name -> same icon either way, so the icon shown stays
// consistent regardless of which path actually resolved it.
export const ACTIVITY_CATEGORIES = [
  { category: 'school', icon: '🎒', keywords: ['school'] },
  { category: 'doctor', icon: '🩺', keywords: ['doctor'] },
  { category: 'dentist', icon: '🦷', keywords: ['dentist'] },
  { category: 'dance', icon: '💃', keywords: ['dance'] },
  { category: 'sports', icon: '⚽', keywords: ['soccer', 'football'] },
  { category: 'gym', icon: '🤸', keywords: ['gym'] },
  { category: 'birthday', icon: '🎉', keywords: ['birthday'] },
  { category: 'playdate', icon: '🧸', keywords: ['playdate'] },
  { category: 'swim', icon: '🏊', keywords: ['swim'] },
  { category: 'music', icon: '🎵', keywords: ['music'] },
  { category: 'piano', icon: '🎹', keywords: ['piano'] },
  { category: 'art', icon: '🎨', keywords: ['art'] },
  // Real bug: "ערב סרט" (Hebrew for "movie night") landed on the 📌
  // last-resort pushpin — not a matching failure (the LLM path is
  // language-agnostic by design), but a real content gap: there was no
  // "movie" category at all in this list for it to classify into, English
  // keyword or not.
  { category: 'movie', icon: '🎬', keywords: ['movie', 'movie night', 'cinema', 'film'] },
  { category: 'pickup', icon: '🚗', keywords: ['pickup'] },
  { category: 'shopping', icon: '🛒', keywords: ['shopping', 'shop', 'groceries'] },
  { category: 'appointment', icon: '📅', keywords: ['appointment'] },
  // Always available to both paths as the true last-resort — the LLM is
  // told explicitly to only use this when nothing else fits.
  { category: 'other', icon: '📌', keywords: [] },
];
