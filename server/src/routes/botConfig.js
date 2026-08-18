// Onboarding step 5 (Connect WhatsApp) + Settings Home > WhatsApp Connection.
// Account-level Meta setup happens manually outside the app (architecture
// doc); this surfaces the bot's number/instructions and confirms receipt
// once a test message arrives (accepted_chat_ids gains an entry).
import { Router } from 'express';
import * as botConfigRepo from '../repositories/botConfig.js';
import { ensureFamilySetup } from '../services/familySetup.js';
import { requireFamily } from './middleware.js';

export function botConfigRouter() {
  const router = Router();
  router.use(requireFamily);

  router.get('/bot-config', async (req, res) => {
    await ensureFamilySetup(req.familyId);
    const config = await botConfigRepo.findByFamilyId(req.familyId);
    res.json({
      botDisplayNumber: config?.bot_display_number || process.env.WHATSAPP_DISPLAY_NUMBER || null,
      connected: !!config?.connected_at,
      acceptedChatIds: config?.accepted_chat_ids ?? [],
    });
  });

  // Called by onboarding step 5 once the parent has sent a first test
  // message and provided the sending number, or driven automatically once
  // the webhook sees a first inbound message from a not-yet-accepted number
  // during setup (kept simple/manual here for Phase 1).
  router.post('/bot-config/confirm', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });
    await ensureFamilySetup(req.familyId);
    const config = await botConfigRepo.findByFamilyId(req.familyId);
    const updated = await botConfigRepo.addAcceptedChatId(config.id, phoneNumber);
    res.json({ connected: true, acceptedChatIds: (updated ?? config).accepted_chat_ids });
  });

  return router;
}
