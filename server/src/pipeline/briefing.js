// D1 (proactive daily briefing) — flips the bot from purely reactive
// (respond to a webhook) to something that initiates on its own, per the
// enhancement backlog's Group D framing. Same "scheduled sweep on an
// interval" infrastructure reminders.js already established (server.js
// runs both on the same 60s cadence) — realistic scale is one household, so
// a queue/cron system would be solving a problem this app doesn't have.
// Depends on A1 (same calendar-read + audience-filter reasoning, different
// trigger) and C1 (the send time is a standing-rule timing_param, not
// hardcoded — D-4).
import * as familiesRepo from '../repositories/families.js';
import * as familyMembersRepo from '../repositories/familyMembers.js';
import * as googleCredentialsRepo from '../repositories/googleCredentials.js';
import * as sourceMappingsRepo from '../repositories/sourceMappings.js';
import * as standingRulesRepo from '../repositories/standingRules.js';
import { todayInTimeZone, nowTimeInTimeZone, shouldSendBriefingNow, addDays, localDateTimeToUtcIso, isRelevantToParent, formatBriefingReply } from './classify.js';

// D-4's stated default; overridden per-family by an active 'timing_param'
// standing rule named 'briefing_send_time' (C1) — e.g. "send the briefing
// at 21:00" — never hardcoded past that one fallback.
const DEFAULT_BRIEFING_TIME = '20:00';

// A Postgres `date` column comes back as a real JS Date from node-postgres
// (and, separately, from pg-mem in tests) — compare on just its calendar
// date portion, not object identity, and handle the column's true null
// (never sent) the same way either driver would represent it.
function dateOnly(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/**
 * Called on an interval (see server.js) or directly by a test. For every
 * family whose local clock has reached its configured briefing time and
 * hasn't been sent one yet today: reads tomorrow's events once, then sends
 * each connected parent their own filtered view of it (isRelevantToParent).
 * @param {{pool: import('pg').Pool, calendar: {listEvents: Function}, messenger: {send: Function}}} deps
 */
export async function sweepDailyBriefings({ pool, calendar, messenger }) {
  const families = await familiesRepo.findAllActive(pool);
  const sent = [];

  for (const family of families) {
    const timeZone = family.timezone || 'UTC';
    const todayLocal = todayInTimeZone(timeZone);
    const dueNow = shouldSendBriefingNow({
      nowLocalHHMM: nowTimeInTimeZone(timeZone),
      sendTime: (await standingRulesRepo.findActiveParam({ familyId: family.id, paramName: 'briefing_send_time' }, pool))?.param_value || DEFAULT_BRIEFING_TIME,
      lastSentDateLocal: dateOnly(family.last_briefing_sent_date),
      todayLocal,
    });
    if (!dueNow) continue;

    const credentials = await googleCredentialsRepo.findByFamilyId(family.id, pool);
    if (!credentials) continue; // nothing to brief without a connected calendar — try again tomorrow

    const familyMembers = await familyMembersRepo.findAllForFamily(family.id, pool);
    const parents = familyMembers.filter((m) => m.is_parent);
    if (!parents.length) continue;

    // D2 — active prep associations this family has taught (C1), consulted
    // once per family per tick rather than once per parent (the same
    // suggestions apply regardless of who's receiving them).
    const taughtPrepRules = await standingRulesRepo.findActiveByKind({ familyId: family.id, ruleKind: 'prep_association' }, pool);

    const tomorrow = addDays(todayLocal, 1);
    let items;
    try {
      items = await calendar.listEvents(credentials, {
        timeMin: localDateTimeToUtcIso(tomorrow, '00:00', timeZone),
        timeMax: localDateTimeToUtcIso(tomorrow, '23:59', timeZone),
      });
    } catch (err) {
      // A transient Calendar API failure shouldn't mark today as "sent" —
      // leave last_briefing_sent_date untouched so the very next sweep
      // tick (within the minute, same as any other retry in this app)
      // tries again, rather than silently skipping the whole day.
      console.error(`Daily briefing: calendar read failed for family ${family.id}`, err);
      continue;
    }

    for (const parent of parents) {
      const mapping = await sourceMappingsRepo.findByFamilyMemberId(
        { familyId: family.id, channelType: 'whatsapp', familyMemberId: parent.id },
        pool
      );
      if (!mapping) continue; // no WhatsApp number on file for this parent — can't message them
      const relevant = items.filter((item) => isRelevantToParent(item, parent.id, familyMembers));
      const reply = formatBriefingReply(relevant, { dateLabel: tomorrow, taughtPrepRules });
      await messenger.send(mapping.external_identifier, reply);
      sent.push({ familyId: family.id, parentId: parent.id, to: mapping.external_identifier });
    }

    await familiesRepo.markBriefingSent(family.id, todayLocal, pool);
  }

  return sent;
}
