// Kid dashboard read endpoint. Pulls straight from Google Calendar
// (filtered to tomorrow), no calendar data duplicated into our own DB.
// Returns the *raw* event + family-member list; capping to 4-5 items,
// icon/color lookup, and wake/bedtime-bookend logic all live in the shared
// frontend module (web/src/theme + web/src/api) per frontend guardrail 1,
// so parent view (Phase 2) can reuse the exact same logic, not a lookalike.
import { Router } from 'express';
import * as familyMembersRepo from '../repositories/familyMembers.js';
import * as activityIconsRepo from '../repositories/activityIcons.js';
import * as googleCredentialsRepo from '../repositories/googleCredentials.js';
import * as calendar from '../integrations/calendar.js';
import { shouldShowOnKidBoard, iconForCategory, sanitizeActivityIcon } from '../pipeline/classify.js';
import { requireFamily } from './middleware.js';

function startOfTomorrow(timezone) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return tomorrow;
}

// Real bug: this used to be the *only* signal for "who is this event for" —
// scanning the event's title/description text for a family member's
// literal name. That's independent of, and much less reliable than, the
// actual match already made and colored at write time
// (classify.js's calendarPayloadFromCandidate): most real titles never
// contain the person's name at all ("Dance class" for Mia, "Dentist" for
// Theo), so this found nothing and the card fell back to a neutral color
// even though the real Calendar event was correctly colored the whole
// time. Now prefers the member actually stored on the event
// (extendedProperties.private.personId, the same match colorId came from —
// one resolution, not two that can drift), unioned with any *additional*
// members the text happens to name (preserves the 2-person stripe / 3+
// avatar-stack display for a message that genuinely mentions more than one
// person — the extraction pipeline only ever resolves one `person` field,
// so text-matching is still the only way to catch a second one). An event
// written before this existed has no personId at all and falls back to the
// text-only heuristic exactly as before.
export function matchMembersToEvent(item, members) {
  const personId = item.extendedProperties?.private?.personId;
  const storedMember = personId ? members.find((m) => m.id === personId) : null;
  const haystack = `${item.summary || ''} ${item.description || ''}`.toLowerCase();
  const textMatches = members.filter((m) => haystack.includes(m.name.toLowerCase()));
  if (!storedMember) return textMatches;
  return [storedMember, ...textMatches.filter((m) => m.id !== storedMember.id)];
}

// Roy's call (live-testing feedback): stop gatekeeping icons behind a small
// fixed category list — the LLM now picks a real emoji directly per event
// (llm.js's activity_icon), covering any activity in any language, not just
// the ones someone thought to hardcode a category for. Priority: the
// free English-keyword match still runs first (activityIconsRepo.resolveIcon
// — no LLM involved, essentially free, and a reasonable sanity-consistent
// choice for the common English cases it does cover); then the icon
// actually stored on the event (extendedProperties.private.activityIcon,
// re-validated here too — an old, already-approved icon shouldn't be
// trusted forever without the same check a fresh one gets); then
// activityCategory for any event written *before* this change (so it
// doesn't regress to the pushpin); only a genuinely untagged event falls
// through to classify.js's own 📌 default.
export function resolveEventIcon(item, icons) {
  const keywordMatch = activityIconsRepo.resolveIcon(icons, item.summary);
  if (keywordMatch) return keywordMatch;
  const storedIcon = item.extendedProperties?.private?.activityIcon;
  if (storedIcon) return sanitizeActivityIcon(storedIcon);
  return iconForCategory(item.extendedProperties?.private?.activityCategory);
}

export function dashboardRouter() {
  const router = Router();
  router.use(requireFamily);

  router.get('/dashboard/tomorrow', async (req, res) => {
    const members = await familyMembersRepo.findAllForFamily(req.familyId);
    const icons = await activityIconsRepo.findAllForFamily(req.familyId);
    const credentials = await googleCredentialsRepo.findByFamilyId(req.familyId);

    if (!credentials) {
      return res.json({ connected: false, members, events: [] });
    }

    const tomorrow = startOfTomorrow();
    const timeMin = new Date(tomorrow.setHours(0, 0, 0, 0)).toISOString();
    const timeMax = new Date(tomorrow.setHours(23, 59, 59, 999)).toISOString();

    let items = [];
    try {
      items = await calendar.listEvents(credentials, { timeMin, timeMax });
    } catch (err) {
      console.error('Failed to list calendar events', err);
      // A dead refresh token (see calendar.js's isReauthRequiredError) is
      // not a transient hiccup — retrying will never succeed until the
      // family reconnects Google Calendar, so it gets a distinct error the
      // frontend can act on (a real "reconnect" prompt) instead of the
      // generic "couldn't load, try again in a bit" that would just loop
      // forever on this specific failure.
      const errorCode = calendar.isReauthRequiredError(err) ? 'reauth_required' : 'calendar_unavailable';
      return res.status(502).json({ connected: true, error: errorCode, members, events: [] });
    }

    // Backlog 4.2 — parent_only events (see classify.js's
    // shouldShowOnKidBoard) never reach the shared board at all, not just
    // visually hidden client-side.
    const events = items.filter(shouldShowOnKidBoard).map((item) => {
      const matchedMembers = matchMembersToEvent(item, members);
      const icon = resolveEventIcon(item, icons);
      return {
        id: item.id,
        title: item.summary || 'Untitled',
        start: item.start?.dateTime || item.start?.date,
        end: item.end?.dateTime || item.end?.date,
        allDay: !item.start?.dateTime,
        icon,
        memberIds: matchedMembers.map((m) => m.id),
      };
    });

    res.json({ connected: true, members, events });
  });

  return router;
}
