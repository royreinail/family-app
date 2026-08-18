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
import { shouldShowOnKidBoard } from '../pipeline/classify.js';
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
      return res.status(502).json({ connected: true, error: 'calendar_unavailable', members, events: [] });
    }

    // Backlog 4.2 — parent_only events (see classify.js's
    // shouldShowOnKidBoard) never reach the shared board at all, not just
    // visually hidden client-side.
    const events = items.filter(shouldShowOnKidBoard).map((item) => {
      const matchedMembers = matchMembersToEvent(item, members);
      const icon = activityIconsRepo.resolveIcon(icons, item.summary);
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
