// Backlog 2.1 — Settings Home > Calendar. Lets a family see every calendar
// their connected Google account can write to and pick which one event
// writes target, instead of always defaulting to whichever calendar was
// primary at OAuth time (google_credentials.calendar_id, defaults 'primary').
import { Router } from 'express';
import * as googleCredentialsRepo from '../repositories/googleCredentials.js';
import * as calendar from '../integrations/calendar.js';
import { requireFamily, requirePinVerified } from './middleware.js';

export function calendarSettingsRouter() {
  const router = Router();
  router.use(requireFamily);

  router.get('/calendar/list', async (req, res) => {
    const credentials = await googleCredentialsRepo.findByFamilyId(req.familyId);
    if (!credentials) return res.json({ connected: false, calendars: [], selectedCalendarId: null });

    let calendars = [];
    try {
      calendars = await calendar.listCalendars(credentials);
    } catch (err) {
      console.error('Failed to list calendars', err);
      return res.status(502).json({ connected: true, error: 'calendar_unavailable', calendars: [], selectedCalendarId: credentials.calendar_id });
    }
    res.json({ connected: true, calendars, selectedCalendarId: credentials.calendar_id });
  });

  router.put('/calendar/selected', requirePinVerified, async (req, res) => {
    const { calendarId } = req.body;
    if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });
    const updated = await googleCredentialsRepo.setCalendarId(req.familyId, calendarId);
    if (!updated) return res.status(404).json({ error: 'Calendar not connected yet' });
    res.json({ calendarId: updated.calendar_id });
  });

  return router;
}
