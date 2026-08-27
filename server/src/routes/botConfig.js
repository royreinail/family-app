// Onboarding step 5 (Connect WhatsApp) + Settings Home > WhatsApp Connection.
// Account-level Meta setup happens manually outside the app (architecture
// doc); this surfaces the bot's number/instructions and confirms receipt
// once a test message arrives (accepted_chat_ids gains an entry).
import { Router } from 'express';
import * as botConfigRepo from '../repositories/botConfig.js';
import * as sourceMappingsRepo from '../repositories/sourceMappings.js';
import { ensureFamilySetup } from '../services/familySetup.js';
import { requireFamily } from './middleware.js';

export function botConfigRouter() {
  const router = Router();
  router.use(requireFamily);

  router.get('/bot-config', async (req, res) => {
    await ensureFamilySetup(req.familyId);
    const config = await botConfigRepo.findByFamilyId(req.familyId);
    const mappings = await sourceMappingsRepo.findAllForFamily(req.familyId);
    res.json({
      botDisplayNumber: config?.bot_display_number || process.env.WHATSAPP_DISPLAY_NUMBER || null,
      connected: !!config?.connected_at,
      acceptedChatIds: config?.accepted_chat_ids ?? [],
      // Item 6 depends on knowing which family member a connected number
      // actually belongs to — surfaced so the client can show "linked to
      // X" per number and prompt for any that aren't yet.
      senderMappings: mappings.map((m) => ({ externalIdentifier: m.external_identifier, familyMemberId: m.family_member_id })),
    });
  });

  // Called by onboarding step 5 once the parent has sent a first test
  // message and provided the sending number, or driven automatically once
  // the webhook sees a first inbound message from a not-yet-accepted number
  // during setup (kept simple/manual here for Phase 1). Also reused from
  // Settings > WhatsApp Connection to (re)link an already-connected number
  // to a family member — real bug: this never recorded who a number
  // belongs to at all, so item 6's forwarded-sender default and its color
  // assignment silently no-op'd for every real message.
  router.post('/bot-config/confirm', async (req, res) => {
    const { phoneNumber, familyMemberId } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });
    await ensureFamilySetup(req.familyId);
    const config = await botConfigRepo.findByFamilyId(req.familyId);
    const updated = await botConfigRepo.addAcceptedChatId(config.id, phoneNumber);
    if (familyMemberId) {
      await sourceMappingsRepo.upsertSender({
        familyId: req.familyId,
        channelType: 'whatsapp',
        externalIdentifier: phoneNumber,
        familyMemberId,
      });
    }
    const mappings = await sourceMappingsRepo.findAllForFamily(req.familyId);
    res.json({
      connected: true,
      acceptedChatIds: (updated ?? config).accepted_chat_ids,
      senderMappings: mappings.map((m) => ({ externalIdentifier: m.external_identifier, familyMemberId: m.family_member_id })),
    });
  });

  return router;
}
