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
    updateEvent: async (id, patch) => {
      events.set(id, { ...events.get(id), ...patch });
      return { provider: 'google', external_id: id };
    },
    deleteEvent: async (id) => {
      events.delete(id);
    },
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
