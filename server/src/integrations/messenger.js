// Thin boundary around the messaging channel (future-proofing item 5).
// Pipeline code calls messenger.send(...) — never the Meta Graph API
// directly inline. Phase 3's group-participant bot needs a different
// connection model entirely; keeping this boundary thin is what lets that
// be a second implementation later instead of a rewrite.
const GRAPH_API_VERSION = 'v20.0';

// Known gap (architecture doc): a freeform text message only sends inside
// the 24h customer-service window a user opens by messaging the bot. The
// capture -> confirmation reply always fires immediately, well inside that
// window, so it's unaffected. Meta rejects an outside-window freeform send
// with error code 131047 ("re-engagement") and requires a pre-approved
// message template instead — this is still real for that plain `send()`
// path below (a capture confirmation could in principle land outside the
// window if the pipeline is ever slow enough, or is manually re-run). It's
// NOT relevant to reminders specifically anymore: reminders always go via
// the one approved template regardless of window (see
// buildReminderTemplatePayload's own comment) — this section's
// re-engagement handling only backs the general-purpose `send`/`sendTemplate`
// pair now, not a reminder-specific fallback.
const REENGAGEMENT_ERROR_CODE = 131047;
const REMINDER_TEMPLATE_NAME = process.env.WHATSAPP_REMINDER_TEMPLATE_NAME || 'reminder_notification';
const REMINDER_TEMPLATE_LANGUAGE = process.env.WHATSAPP_REMINDER_TEMPLATE_LANGUAGE || 'en_US';
// Meta's WhatsApp Manager now requires a *named* variable (lowercase +
// underscores, wrapped in {{ }}, not the older positional {{1}}) — must
// match whatever name the approved template actually uses. See
// family-app-architecture.md for the exact template text submitted.
const REMINDER_TEMPLATE_PARAM_NAME = process.env.WHATSAPP_REMINDER_TEMPLATE_PARAM_NAME || 'reminder_text';

export async function send(to, text, opts = {}) {
  const { phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID, token = process.env.WHATSAPP_SYSTEM_USER_TOKEN } = opts;
  if (!phoneNumberId || !token) {
    // Phase 1 personal-use fallback: log instead of throwing, so the pipeline
    // keeps working end-to-end (e.g. in local/dev use) before WhatsApp is wired up.
    console.log(`[messenger:noop] -> ${to}: ${text}`);
    return { ok: true, noop: true };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (isReengagementWindowError(body)) {
      console.warn(`WhatsApp send to ${to} fell outside the 24h window — retrying as template "${REMINDER_TEMPLATE_NAME}"`);
      return sendTemplate(to, text, opts);
    }
    throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
  }
  return res.json();
}

// F2 (actionable reminders) — the pure wire-format builder for the
// reminder template send, extracted for the same reason buildSystemPrompt
// is pulled out of the real LLM call: testable without a network call.
//
// Roy's call (live-testing feedback, after the reminder_notification
// template got Meta-approved): reminders send via this ONE format only —
// no free-form-first-then-template-fallback fork. There used to be a
// second path here (a free-form interactive message, tried first, falling
// back to this template only outside the 24h customer-service window) —
// removed. Two real reasons it wasn't worth keeping once the template was
// actually approved: (1) the template works identically inside or outside
// the window, so the fork bought nothing functionally, only branching
// complexity and a second wire shape to keep in sync; (2) Meta's own
// pricing overhaul (effective Oct 1 2026) removes the free-inside-window
// exemption for BOTH service messages and utility templates, so even the
// cost argument for keeping the free-form path narrows to nothing at this
// app's actual (personal-family, low-volume) traffic. See
// family-app-architecture.md's F2 section for the template's own
// classification/cost details (it briefly went PENDING/MARKETING — an
// appeal to UTILITY is a separate, Roy-side action, tracked there).
export function buildReminderTemplatePayload(to, composed) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: REMINDER_TEMPLATE_NAME,
      language: { code: REMINDER_TEMPLATE_LANGUAGE },
      components: [
        { type: 'body', parameters: [{ type: 'text', parameter_name: REMINDER_TEMPLATE_PARAM_NAME, text: composed.innerText }] },
        ...composed.buttons.map((b, index) => ({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(index),
          parameters: [{ type: 'payload', payload: b.id }],
        })),
      ],
    },
  };
}

// F2 — the sole reminder-delivery path (see the comment above
// buildReminderTemplatePayload for why there's no longer a free-form
// fallback fork here). The template's own fixed copy (wrapper text + the
// two quick-reply buttons) is baked into what Meta already approved — this
// only ever supplies the body VARIABLE and each button's PAYLOAD, never
// re-describes the button labels (Meta owns those once approved;
// composed.buttons is only consulted for the id/index pairing and payload
// — reminderMessage.js's REMINDER_BUTTONS is what has to stay in sync with
// the approved template's actual button set, not this call).
export async function sendReminderButtonTemplate(to, composed, { phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID, token = process.env.WHATSAPP_SYSTEM_USER_TOKEN } = {}) {
  if (!phoneNumberId || !token) {
    console.log(`[messenger:noop:button-template] -> ${to}: ${composed.bodyText}`);
    return { ok: true, noop: true };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildReminderTemplatePayload(to, composed)),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp button template send failed (${res.status}): ${body}`);
  }
  return res.json();
}

export function isReengagementWindowError(rawBody) {
  try {
    return JSON.parse(rawBody)?.error?.code === REENGAGEMENT_ERROR_CODE;
  } catch {
    return false;
  }
}

// A pre-approved template with exactly one body variable — see
// family-app-architecture.md for the exact text submitted for Meta's
// review. `bodyText` becomes {{reminder_text}} verbatim (e.g. "Reminder:
// pick up the dry cleaning"), so the template's own fixed copy deliberately
// carries no "Reminder:" prefix of its own — avoids double-prefixing when
// reminders.js's scheduleReminder already builds that into the title.
export async function sendTemplate(to, bodyText, { phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID, token = process.env.WHATSAPP_SYSTEM_USER_TOKEN } = {}) {
  if (!phoneNumberId || !token) {
    console.log(`[messenger:noop:template] -> ${to}: ${bodyText}`);
    return { ok: true, noop: true };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: REMINDER_TEMPLATE_NAME,
        language: { code: REMINDER_TEMPLATE_LANGUAGE },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', parameter_name: REMINDER_TEMPLATE_PARAM_NAME, text: bodyText }],
          },
        ],
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp template send failed (${res.status}): ${body}`);
  }
  return res.json();
}

// Forwarded photos (flyers, schedules) are one of Phase 1's three intake
// channels, but a WhatsApp image message carries only a media ID — the
// actual bytes need a separate two-step fetch: look up the (short-lived,
// signed) download URL, then fetch that URL, both calls needing the same
// bearer token. Returns base64 + mime type, ready for the LLM boundary's
// vision input.
export async function downloadMedia(mediaId, { token = process.env.WHATSAPP_SYSTEM_USER_TOKEN } = {}) {
  if (!token) throw new Error('WHATSAPP_SYSTEM_USER_TOKEN is not set — cannot download WhatsApp media.');

  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    throw new Error(`WhatsApp media lookup failed (${metaRes.status}): ${await metaRes.text()}`);
  }
  const { url, mime_type: mimeType } = await metaRes.json();

  const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) {
    throw new Error(`WhatsApp media download failed (${fileRes.status}): ${await fileRes.text()}`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { base64: buffer.toString('base64'), mimeType: mimeType || 'image/jpeg' };
}
