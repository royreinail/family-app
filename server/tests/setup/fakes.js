// Fakes for the boundary layer (calendar / messenger / LLM) — the pipeline
// only ever depends on the thin interfaces in src/integrations/, so tests
// substitute simple recording fakes instead of hitting real APIs.
import { randomUUID } from 'node:crypto';

export function createFakeCalendar() {
  const events = new Map();
  return {
    events,
    createEvent: async (evt) => {
      const id = `gcal-${randomUUID()}`;
      events.set(id, evt);
      return { provider: 'google', external_id: id };
    },
    // A real patch (see calendar.js's updateEvent / pipeline.js's
    // applyPersonCorrection) nests app metadata under
    // `extendedProperties.private`, matching Google's real wire format —
    // but createEvent above stores the flat calendarPayloadFromCandidate
    // shape directly (personId/audience/activityIcon all top-level, for
    // easy test assertions like `written.personId`). Unwrap that nesting
    // here too, onto the same flat record, so a test can assert
    // `written.personId` consistently regardless of whether it came from
    // the original create or a later correction.
    updateEvent: async (id, patch) => {
      const { extendedProperties, ...rest } = patch;
      const flatPrivateProps = extendedProperties?.private ?? {};
      events.set(id, { ...events.get(id), ...rest, ...flatPrivateProps });
      return { provider: 'google', external_id: id };
    },
    deleteEvent: async (id) => {
      events.delete(id);
    },
    // A1 (read-back queries) — converts the fake's flat internal storage
    // back into the real Google Calendar item shape the filtering logic
    // (shouldShowOnKidBoard/matchMembersToEvent/formatQueryReply) actually
    // expects, same shape dashboard.js's real listEvents already returns.
    // Deliberately ignores timeMin/timeMax and returns everything stored —
    // date-range filtering itself is the real Google API boundary call,
    // not unit-tested here for the same reason no other real
    // integrations/ call is; tests exercise the *filtering* logic
    // (audience, person-scoping) against events they explicitly created,
    // not against a reimplementation of Calendar's own range semantics.
    listEvents: async () =>
      [...events.entries()].map(([id, e]) => ({
        id,
        summary: e.title,
        description: e.description,
        start: { dateTime: e.startDateTime },
        end: { dateTime: e.endDateTime },
        extendedProperties: {
          private: {
            ...(e.audience ? { audience: e.audience } : {}),
            ...(e.activityIcon ? { activityIcon: e.activityIcon } : {}),
            ...(e.personId ? { personId: e.personId } : {}),
          },
        },
      })),
  };
}

export function createFakeMessenger() {
  const sent = [];
  return {
    sent,
    send: async (to, text) => {
      sent.push({ to, text });
      return { ok: true };
    },
  };
}

// Maps fixed input text -> canned extraction output, so tests don't need a
// real ANTHROPIC_API_KEY or network access. Mirrors exactly what the real
// LLM boundary (src/integrations/llm.js) would return for that input.
export function createFakeLlm(responses) {
  const calls = [];
  return {
    calls,
    extract: async (rawInput) => {
      calls.push(rawInput);
      if (rawInput in responses) return responses[rawInput];
      throw new Error(`No fake LLM response registered for: ${rawInput}`);
    },
  };
}
