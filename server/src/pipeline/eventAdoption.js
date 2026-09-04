// Adopts Google Calendar events the bot didn't create — someone added it
// directly in Google Calendar, not by forwarding a WhatsApp message. Every
// calendar read in this app (A1/A2, the daily briefing, the kid dashboard,
// B3's conflict check) pulls the WHOLE connected calendar already —
// source-agnostic, nothing here was ever bot-only — but a manually-added
// event has no `personId` tag (only the bot sets that at creation), so it
// falls back to a live text-match on every single read and, worse, is
// completely invisible to B3's conflict check, which only ever compares
// `personId` directly (no text-match fallback there at all).
//
// When exactly one family member's name confidently matches a
// not-yet-tracked event's title/description, this "adopts" it: patches
// `personId` onto the real Calendar event (invisible metadata only, same
// as every other personId write in this codebase — nothing changes in
// Calendar's own UI) and writes a synthetic extraction_log row (state
// 'written', no sender/raw_input since there was no incoming message) so
// it shows up in the app's own audit trail and — just as importantly —
// so the presence of that row is what tells every future sweep "already
// considered this one," rather than re-matching from scratch every tick.
// Zero or more than one matching name is left alone, same "don't guess"
// philosophy as matchSingleFamilyMember itself — nothing is EVER adopted
// on an ambiguous or absent match.
import { getPool } from '../db/pool.js';
import * as extractionLogRepo from '../repositories/extractionLog.js';
import { matchSingleFamilyMember } from './classify.js';

/**
 * @param {object[]} items - real Google Calendar event resources (whatever shape calendar.js's listEvents already returns)
 * @param {{familyId: string, familyMembers: object[], updateEvent: (id: string, patch: object) => Promise, pool?: import('pg').Pool}} opts
 * @returns {Promise<object[]>} the SAME items, with any adopted event's `extendedProperties` updated in place —
 *   so a caller reading this exact batch right after (e.g. B3's conflict check, run in the same tick) sees the
 *   new personId immediately, not only on the next read.
 */
export async function adoptUntrackedEvents(items, { familyId, familyMembers, updateEvent, pool = getPool() }) {
  for (const item of items) {
    if (item.extendedProperties?.private?.personId) continue; // already tracked — bot-created or previously adopted

    try {
      const alreadyConsidered = await extractionLogRepo.findByCalendarEventId({ familyId, externalId: item.id }, pool);
      if (alreadyConsidered) continue; // adopted before, or deliberately left ambiguous — don't re-attempt every tick

      const matched = matchSingleFamilyMember(`${item.summary || ''} ${item.description || ''}`, familyMembers);
      if (!matched) continue; // zero or ambiguous — never guess

      const privateProps = { ...(item.extendedProperties?.private || {}), personId: matched.id };
      await updateEvent(item.id, { extendedProperties: { private: privateProps } });

      const log = await extractionLogRepo.create(
        {
          familyId,
          rawInput: '(event added directly in Google Calendar, not via the bot)',
          senderIdentifier: null,
          externalMessageId: `adopted:${item.id}`,
        },
        pool
      );
      await extractionLogRepo.updateState(
        log.id,
        {
          state: 'written',
          resultingEventRef: { provider: 'google', external_id: item.id },
          aiCandidate: {
            title: item.summary || null,
            date: (item.start?.dateTime || item.start?.date || '').slice(0, 10) || null,
            time: item.start?.dateTime ? item.start.dateTime.slice(11, 16) : null,
            person: matched.name,
            audience: item.extendedProperties?.private?.audience || 'family',
            activity_icon: item.extendedProperties?.private?.activityIcon || null,
            adopted: true,
          },
        },
        pool
      );

      // Reflect the patch in THIS batch too, not just the real Calendar
      // event — a caller iterating `items` right after this call (e.g. B3's
      // conflict check on the very same read) should see the new personId
      // immediately.
      item.extendedProperties = { private: privateProps };
    } catch (err) {
      // Best-effort, exactly like B3's own conflict check: adopting one
      // event failing (a stale event id, a transient Calendar API error)
      // must never break the actual read this function was called ahead
      // of — log it and move on to the next item.
      console.error(`Event adoption failed for ${item.id} (non-blocking)`, err);
    }
  }
  return items;
}
