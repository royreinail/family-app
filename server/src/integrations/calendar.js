// Thin boundary around the calendar provider (future-proofing item 5).
// Business logic elsewhere calls calendar.createEvent(...) / .updateEvent(...)
// / .deleteEvent(...) — never the googleapis SDK directly. Turns Phase 3's
// multi-provider sync into "add a second implementation of this interface,"
// not a rewrite.
import { google } from 'googleapis';

// Real production case (confirmed from logs): `GaxiosError: invalid_grant`
// when Google refuses to refresh the access token — the refresh token
// itself is dead (revoked, the account's password changed, or — very
// plausible while GOOGLE_OAUTH_CLIENT_ID's consent screen is still in
// "Testing" publishing status — Google expires unused refresh tokens after
// 7 days there). This is NOT transient: retrying the same request will
// never succeed, unlike a genuine API hiccup. The caller (dashboard.js)
// uses this to show "reconnect your calendar" instead of a generic
// "couldn't load, try again" that would never actually resolve on its own.
export function isReauthRequiredError(err) {
  return (
    err?.response?.data?.error === 'invalid_grant' ||
    String(err?.message || '').includes('invalid_grant')
  );
}

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
export async function createEvent(credentials, { title, startDateTime, endDateTime, timeZone, colorId, description, audience, activityIcon, personId, location, recurrence } = {}) {
  const calendar = clientFor(credentials);
  // Kept out of the visible summary/description on purpose —
  // extendedProperties.private is invisible in Calendar's own UI, so this
  // is pure app metadata, read back by the kid dashboard (classify.js's
  // shouldShowOnKidBoard for audience; dashboard.js reads activityIcon
  // straight through, same reasoning for personId — the same family member
  // match that decided colorId here is stored directly, so the dashboard
  // reads back the actual resolved identity instead of re-guessing from the
  // event's text at read time, which is a real bug this fixed: most titles
  // never contain the person's literal name), never something a parent has
  // to see or edit through Calendar itself.
  const privateProps = {};
  if (audience) privateProps.audience = audience;
  if (activityIcon) privateProps.activityIcon = activityIcon;
  if (personId) privateProps.personId = personId;

  const { data } = await calendar.events.insert({
    calendarId: credentials.calendar_id || 'primary',
    requestBody: {
      summary: title,
      // B4 (provenance) — the original WhatsApp message text, verbatim
      // (classify.js's calendarPayloadFromCandidate). This field had no
      // real prior writer (attendeeNames, its only earlier source, was
      // defined but never actually populated by any caller).
      description,
      // Google's API rejects a bare dateTime (no UTC offset) unless timeZone
      // is also given — our extracted times are wall-clock in the family's
      // own timezone, so this has to travel with every write.
      start: { dateTime: startDateTime, timeZone },
      end: { dateTime: endDateTime, timeZone },
      colorId,
      // B1 — the event's own native location field (Google's UI, and any
      // "directions" affordance, reads this directly), not folded into the
      // title text the way an address used to get stuffed in before this
      // field existed.
      location: location || undefined,
      // B2 — an array of RRULE strings (classify.js's buildRecurrenceRule);
      // Google Calendar owns all the actual repeat-occurrence behavior once
      // this is set on the event resource, same field name on the wire as
      // in our own payload — no repeat logic to build here.
      recurrence: recurrence?.length ? recurrence : undefined,
      extendedProperties: Object.keys(privateProps).length ? { private: privateProps } : undefined,
    },
  });
  return { provider: 'google', external_id: data.id };
}

// NOTE for any caller patching `extendedProperties.private`: whether
// Calendar's PATCH merges that nested map per-key or replaces it wholesale
// isn't verified here, and guessing wrong would silently wipe
// audience/activityIcon whenever something else patches just one key (e.g.
// a person correction patching personId) — a real visibility bug (a
// kid-hidden event reverting to shown, or vice versa), not just cosmetic.
// Callers should send the *complete* intended private-props object every
// time (not a partial one), same as createEvent already does — see
// pipeline.js's applyPersonCorrection for the pattern.
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

// Backlog 2.1 — pure filter+map from Google's raw calendarList.list() item
// shape to what the app needs. Split out from listCalendars() specifically
// so it has real test coverage (tests/regression/calendarList.test.js, built
// from a real captured response — see that file) without needing to mock
// the Google API call itself, same reasoning as classify.js's other pulled-
// out pure helpers.
export function mapCalendarListItems(items) {
  return (items || [])
    .filter((cal) => cal.accessRole === 'owner' || cal.accessRole === 'writer')
    .map((cal) => ({ id: cal.id, summary: cal.summary, primary: !!cal.primary }));
}

// Lets a family choose which of their Google Calendars events get written
// to, instead of always defaulting to whichever calendar was primary at
// OAuth time. Returns every calendar the signed-in Google account can write
// to (own + shared-with-write-access), since a write to a read-only shared
// calendar would just fail.
export async function listCalendars(credentials) {
  const calendar = clientFor(credentials);
  const { data } = await calendar.calendarList.list();
  return mapCalendarListItems(data.items);
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
