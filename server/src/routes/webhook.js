// WhatsApp Cloud API webhook. Normalizes Meta's payload shape into the
// pipeline's plain message shape, resolves which family it belongs to via
// bot_config.phone_number_id, and wires family-scoped production
// boundary implementations before calling the pipeline.
import { Router } from 'express';
import * as botConfigRepo from '../repositories/botConfig.js';
import * as googleCredentialsRepo from '../repositories/googleCredentials.js';
import * as familiesRepo from '../repositories/families.js';
import * as extractionLogRepo from '../repositories/extractionLog.js';
import { handleIncomingMessage } from '../pipeline/pipeline.js';
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
      if (!phoneNumberId || !message) return;

      const botConfig = await botConfigRepo.findByPhoneNumberId(phoneNumberId);
      if (!botConfig) {
        console.warn(`Webhook message for unrecognized phone_number_id ${phoneNumberId}`);
        return;
      }

      const text = message.text?.body || message.button?.text || '';
      const senderIdentifier = message.from;
      const replyContextId = message.context?.id ?? null;

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
      console.log(
        `Webhook: family=${botConfig.family_id} sender=${senderIdentifier} text=${JSON.stringify(text)} hasCalendarCreds=${!!credentials}`
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
          llmExtract: (raw) => llmIntegration.extract(raw),
          calendar: {
            createEvent: (evt) => calendarIntegration.createEvent(credentials, evt),
            updateEvent: (id, patch) => calendarIntegration.updateEvent(credentials, id, patch),
            deleteEvent: (id) => calendarIntegration.deleteEvent(credentials, id),
          },
          messenger: { send: (to, msg) => messengerIntegration.send(to, msg) },
          timeZone: family?.timezone || 'UTC',
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
