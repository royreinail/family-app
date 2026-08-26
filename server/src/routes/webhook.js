// WhatsApp Cloud API webhook. Normalizes Meta's payload shape into the
// pipeline's plain message shape, resolves which family it belongs to via
// bot_config.phone_number_id, and wires family-scoped production
// boundary implementations before calling the pipeline.
import { Router } from 'express';
import * as botConfigRepo from '../repositories/botConfig.js';
import * as googleCredentialsRepo from '../repositories/googleCredentials.js';
import * as familiesRepo from '../repositories/families.js';
import * as familyMembersRepo from '../repositories/familyMembers.js';
import * as extractionLogRepo from '../repositories/extractionLog.js';
import { handleIncomingMessage } from '../pipeline/pipeline.js';
import { todayInTimeZone } from '../pipeline/classify.js';
import * as calendarIntegration from '../integrations/calendar.js';
import * as messengerIntegration from '../integrations/messenger.js';
import * as llmIntegration from '../integrations/llm.js';

export function webhookRouter() {
  const router = Router();

  // Meta's webhook subscription handshake.
  router.get('/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  });

  router.post('/whatsapp', async (req, res) => {
    // Ack immediately — Meta retries on anything but a fast 2xx, and retries
    // are exactly what external_message_id dedup exists to absorb.
    res.sendStatus(200);

    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const phoneNumberId = change?.metadata?.phone_number_id;
      const message = change?.messages?.[0];
      if (!phoneNumberId || !message) {
        // Meta posts more than just messages to this same URL — delivery
        // and read-receipt status callbacks are routine and fine to skip
        // silently. But this exact `return` used to skip *everything* that
        // didn't parse with zero logging, which was the only thing standing
        // between "Meta never called us" and "Meta called us with a shape
        // we didn't handle" for two real messages that got no response at
        // all during live testing (no trace of either exists to check now —
        // this is so the next one is actually diagnosable).
        if (!change?.statuses) {
          console.warn(
            `Webhook: unparseable payload — phoneNumberId=${phoneNumberId ?? 'missing'} hasMessages=${!!change?.messages} changeKeys=${change ? Object.keys(change).join(',') : 'none (no entry/changes/value at all)'}`
          );
        }
        return;
      }

      const botConfig = await botConfigRepo.findByPhoneNumberId(phoneNumberId);
      if (!botConfig) {
        console.warn(`Webhook message for unrecognized phone_number_id ${phoneNumberId}`);
        return;
      }

      let text = message.text?.body || message.button?.text || '';
      const senderIdentifier = message.from;
      const replyContextId = message.context?.id ?? null;

      // Forwarded photos (flyers, schedules) are a Phase 1 intake channel —
      // WhatsApp sends the image as a media ID, not inline bytes.
      let image = null;
      if (message.type === 'image' && message.image?.id) {
        try {
          image = await messengerIntegration.downloadMedia(message.image.id);
          text = message.image.caption || text;
        } catch (err) {
          console.error('Failed to download WhatsApp image media', err);
        }
      }

      let replyToExtractionLogId = null;
      if (replyContextId) {
        const original = await extractionLogRepo.findByExternalId({
          familyId: botConfig.family_id,
          externalMessageId: replyContextId,
        });
        replyToExtractionLogId = original?.id ?? null;
      }

      const credentials = await googleCredentialsRepo.findByFamilyId(botConfig.family_id);
      const family = await familiesRepo.findById(botConfig.family_id);
      const familyMembers = await familyMembersRepo.findAllForFamily(botConfig.family_id);
      const timeZone = family?.timezone || 'UTC';
      console.log(
        `Webhook: family=${botConfig.family_id} sender=${senderIdentifier} text=${JSON.stringify(text)} hasImage=${!!image} hasCalendarCreds=${!!credentials}`
      );

      const result = await handleIncomingMessage(
        {
          familyId: botConfig.family_id,
          externalMessageId: message.id,
          senderIdentifier,
          text,
          replyToExtractionLogId,
        },
        {
          llmExtract: (raw) =>
            llmIntegration.extract(raw, {
              referenceDate: todayInTimeZone(timeZone),
              image,
              // Fixes a real bug: a message naming a real family member
              // ("Shopping with Shai") had no way to be recognized as
              // referring to her specifically — the LLM had never been told
              // who the family's members even are, so the name just stayed
              // part of the free-text title instead of resolving to
              // `person` (which is what color-matching keys off of).
              familyMemberNames: familyMembers.map((m) => m.name),
            }),
          calendar: {
            createEvent: (evt) => calendarIntegration.createEvent(credentials, evt),
            updateEvent: (id, patch) => calendarIntegration.updateEvent(credentials, id, patch),
            deleteEvent: (id) => calendarIntegration.deleteEvent(credentials, id),
          },
          messenger: { send: (to, msg) => messengerIntegration.send(to, msg) },
          timeZone,
          familyMembers,
        }
      );
      console.log(
        `Webhook result: outcome=${result?.outcome} rule=${result?.rule?.name ?? ''} reason=${result?.reason ?? ''} error=${result?.error?.message ?? ''}`
      );
    } catch (err) {
      console.error('Webhook processing failed', err);
    }
  });

  return router;
}
