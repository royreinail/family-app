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
import * as sourceMappingsRepo from '../repositories/sourceMappings.js';
import { handleIncomingMessage } from '../pipeline/pipeline.js';
import { todayInTimeZone } from '../pipeline/classify.js';
import * as calendarIntegration from '../integrations/calendar.js';
import * as messengerIntegration from '../integrations/messenger.js';
import * as llmIntegration from '../integrations/llm.js';

// A shared photo arrives one of two shapes depending on how the sender
// sent it: the native "image" type (auto-compressed), or a "document"
// whose mime_type happens to be an image (common when someone
// deliberately avoids WhatsApp's compression to keep flyer text legible)
// — both carry real bytes behind a media ID the same way. Only the first
// was ever handled here, so a photo shared as a document silently got
// neither an image nor any text at all — real bug: "wasn't able to
// manage [the image] at all." Exported and tested directly (pure, no
// network) since the real WhatsApp/media-download calls around it aren't
// unit-tested, same as every other real integration call in this codebase.
export function resolveImageMediaRef(message) {
  if (message?.type === 'image' && message.image?.id) {
    return { id: message.image.id, caption: message.image.caption };
  }
  if (message?.type === 'document' && message.document?.id && message.document?.mime_type?.startsWith('image/')) {
    return { id: message.document.id, caption: message.document.caption };
  }
  return null;
}

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
      // Item 6 — Meta's own signal for "this message was forwarded from
      // elsewhere," distinct from context.id (reply/quote metadata) above.
      const wasForwarded = message.context?.forwarded === true;

      // Forwarded photos (flyers, schedules) are a Phase 1 intake channel —
      // WhatsApp sends the image as a media ID, not inline bytes.
      const mediaRef = resolveImageMediaRef(message);

      let image = null;
      let imageDownloadFailed = false;
      if (mediaRef) {
        try {
          image = await messengerIntegration.downloadMedia(mediaRef.id);
          text = mediaRef.caption || text;
        } catch (err) {
          console.error('Failed to download WhatsApp image media', err);
          imageDownloadFailed = true;
        }
      }

      // Nothing at all for the pipeline to work with — either the image
      // download itself failed, or the message is some other type we
      // don't read (audio, video, sticker, location, a non-image
      // document...). Previously this fell all the way through to
      // extraction_classification:nothing_usable, whose action is
      // `{type: 'stop', reply: 'none'}` — completely silent, indistinguishable
      // from Meta never having called us at all. Say so directly instead;
      // "every message should receive at least some response" (Roy). One
      // deliberate exception: a 👍-style reaction to a bot message is not a
      // request needing a response — replying to every reaction would be
      // its own new annoyance, not a fix.
      const isReaction = message.type === 'reaction';
      if (!isReaction && (imageDownloadFailed || (!text && !image && message.type !== 'text' && message.type !== 'button'))) {
        await messengerIntegration.send(
          senderIdentifier,
          imageDownloadFailed
            ? "I couldn't download that photo — mind sending it again?"
            : "I can only read text messages and photos right now — try resending as one of those."
        );
        return;
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

      // Item 6 — which real family member owns the sender's own number, if
      // any (the target of the "assume it's for whoever forwarded this"
      // default, applied downstream only when the message actually was
      // forwarded and doesn't already name someone).
      const senderMapping = await sourceMappingsRepo.findByIdentifier({
        familyId: botConfig.family_id,
        channelType: 'whatsapp',
        externalIdentifier: senderIdentifier,
      });
      const senderFamilyMember = senderMapping
        ? familyMembers.find((m) => m.id === senderMapping.family_member_id) ?? null
        : null;
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
          wasForwarded,
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
            // A1 (read-back queries) — same real listEvents call
            // dashboard.js already uses for the kid board.
            listEvents: (range) => calendarIntegration.listEvents(credentials, range),
          },
          messenger: { send: (to, msg) => messengerIntegration.send(to, msg) },
          // A1 — lets a read-back query give a clean "connect Calendar
          // first" reply instead of a generic API-failure message when
          // there's nothing to even attempt a read against.
          calendarConnected: !!credentials,
          timeZone,
          familyMembers,
          senderFamilyMember,
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
