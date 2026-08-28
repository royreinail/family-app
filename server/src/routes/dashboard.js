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

function matchMembersToEvent(event, members) {
  const haystack = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
  const matched = members.filter((m) => haystack.includes(m.name.toLowerCase()));
  return matched.length ? matched : [];
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
