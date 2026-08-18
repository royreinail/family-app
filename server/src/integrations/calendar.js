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
export async function createEvent(credentials, { title, startDateTime, endDateTime, timeZone, colorId, attendeeNames, audience } = {}) {
  const calendar = clientFor(credentials);
  const { data } = await calendar.events.insert({
    calendarId: credentials.calendar_id || 'primary',
    requestBody: {
      summary: title,
      description: attendeeNames?.length ? `With: ${attendeeNames.join(', ')}` : undefined,
      // Google's API rejects a bare dateTime (no UTC offset) unless timeZone
      // is also given — our extracted times are wall-clock in the family's
      // own timezone, so this has to travel with every write.
      start: { dateTime: startDateTime, timeZone },
      end: { dateTime: endDateTime, timeZone },
      colorId,
      // Backlog 4.1 — kept out of the visible summary/description on
      // purpose (extendedProperties.private is invisible in Calendar's own
      // UI) so this is pure app metadata, read back by the kid dashboard's
      // filter (classify.js's shouldShowOnKidBoard), not something a parent
      // has to see or edit through Google Calendar itself.
      extendedProperties: audience ? { private: { audience } } : undefined,
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

// Backlog 2.1 — lets a family choose which of their Google Calendars events
// get written to, instead of always defaulting to whichever calendar was
// primary at OAuth time. Returns every calendar the signed-in Google account
// can write to (own + shared-with-write-access), since a event write to a
// read-only shared calendar would just fail.
export async function listCalendars(credentials) {
  const calendar = clientFor(credentials);
  const { data } = await calendar.calendarList.list();
  // TEMP DEBUG (remove after capturing a real response shape for
  // tests/regression/calendarList.test.js) — logs the raw Google response
  // so a real fixture can be built instead of a guessed one. No token data
  // in here, just calendar metadata (id/summary/accessRole/etc).
  console.log('DEBUG calendarList.list raw items:', JSON.stringify(data.items));
  return (data.items || [])
    .filter((cal) => cal.accessRole === 'owner' || cal.accessRole === 'writer')
    .map((cal) => ({ id: cal.id, summary: cal.summary, primary: !!cal.primary }));
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
