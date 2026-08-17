// Thin boundary around the calendar provider (future-proofing item 5).
// Business logic elsewhere calls calendar.createEvent(...) / .updateEvent(...)
// / .deleteEvent(...) — never the googleapis SDK directly. Turns Phase 3's
// multi-provider sync into "add a second implementation of this interface,"
// not a rewrite.
import { google } from 'googleapis';

function clientFor(credentials) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    access_token: credentials.access_token,
    refresh_token: credentials.refresh_token,
    expiry_date: credentials.expiry_date ? new Date(credentials.expiry_date).getTime() : undefined,
  });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

/**
 * @returns {Promise<{provider: 'google', external_id: string}>}
 */
export async function createEvent(credentials, { title, startDateTime, endDateTime, colorId, attendeeNames } = {}) {
  const calendar = clientFor(credentials);
  const { data } = await calendar.events.insert({
    calendarId: credentials.calendar_id || 'primary',
    requestBody: {
      summary: title,
      description: attendeeNames?.length ? `With: ${attendeeNames.join(', ')}` : undefined,
      start: { dateTime: startDateTime },
      end: { dateTime: endDateTime },
      colorId,
    },
  });
  return { provider: 'google', external_id: data.id };
}

export async function updateEvent(credentials, externalId, patch) {
  const calendar = clientFor(credentials);
  const { data } = await calendar.events.patch({
    calendarId: credentials.calendar_id || 'primary',
    eventId: externalId,
    requestBody: patch,
  });
  return { provider: 'google', external_id: data.id };
}

export async function deleteEvent(credentials, externalId) {
  const calendar = clientFor(credentials);
  await calendar.events.delete({
    calendarId: credentials.calendar_id || 'primary',
    eventId: externalId,
  });
}

// Used by the kid dashboard — pulls straight from Google Calendar (filtered
// to a date range), never duplicated into the app's own database.
export async function listEvents(credentials, { timeMin, timeMax }) {
  const calendar = clientFor(credentials);
  const { data } = await calendar.events.list({
    calendarId: credentials.calendar_id || 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return data.items || [];
}
