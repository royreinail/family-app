// Thin boundary around the messaging channel (future-proofing item 5).
// Pipeline code calls messenger.send(...) — never the Meta Graph API
// directly inline. Phase 3's group-participant bot needs a different
// connection model entirely; keeping this boundary thin is what lets that
// be a second implementation later instead of a rewrite.
const GRAPH_API_VERSION = 'v20.0';

// Known gap (architecture doc): a freeform text message only sends inside
// the 24h customer-service window a user opens by messaging the bot. The
// capture -> confirmation reply always fires immediately, well inside that
// window, so it's unaffected — but a reminder is very often hours or days
// later, i.e. outside it by the time sweepDueReminders fires. Meta rejects
// that with error code 131047 ("re-engagement" — more than 24h since the
// user's last message) and requires a pre-approved message template
// instead. Rather than trying to predict the window in application code
// (fragile — depends on the *user's* last message time, which this app
// doesn't track), catch that specific rejection and retry once as a
// template send.
//
// F2 (actionable reminders) applies this exact same pattern deliberately —
// see sendReminderButtons/sendReminderButtonTemplate below — and it's a
// COST decision as much as a delivery one: a free-form message inside the
// window is currently free, while the approved reminder_notification
// template is billed per send (its category was auto-shifted
// UTILITY -> MARKETING when its buttons were added — likely a
// mis-classification, appeal pending, see family-app-architecture.md's F2
// section), so the template is deliberately kept as the fallback, not
// promoted to primary, even though it's now approved and could reach a
// recipient regardless of window. Revisit this once Meta's Oct 1 2026
// pricing change removes the free-inside-window exemption for both paths
// anyway — at that point the cost argument for keeping the fork narrows to
// nothing and collapsing to one path (as was tried once already) becomes
// the better trade again.
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

// F2 (actionable reminders) — the pure wire-format builders. Both send
// functions below MUST build their wire body only through these two, never
// inventing a shape of their own — that's what makes "same look and feel,
// user can't tell which path a reminder came through" (Roy's own
// requirement) an enforced property, not a hope: both take the exact same
// `composed` (reminderMessage.js's composeReminderMessage(task) output) as
// their only source of copy/buttons, and
// tests/regression/actionableReminders.test.js asserts both payloads
// resolve to the identical button id/title set for the same input. Also
// what makes the backlog's own explicit test requirement ("add a test
// asserting both renderers produce the same button set and labels")
// checkable at all without a real network call, same reasoning
// buildSystemPrompt is pulled out of the real LLM call for.
export function buildInteractiveButtonsPayload(to, composed) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: composed.bodyText },
      action: {
        buttons: composed.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    },
  };
}

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

// Free-form interactive message, the primary path — deliberately kept
// primary even though the button template is now approved and could reach
// anyone regardless of window: it's currently free (see the cost note
// above), so this is what most reminders actually use in practice (only
// falling to the template when neither parent has messaged that day).
// `composed` is reminderMessage.js's composeReminderMessage(task) output —
// this adapter owns nothing about the reminder's own structure, only how
// to shape it for the wire (via buildInteractiveButtonsPayload above).
export async function sendReminderButtons(to, composed, opts = {}) {
  const { phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID, token = process.env.WHATSAPP_SYSTEM_USER_TOKEN } = opts;
  if (!phoneNumberId || !token) {
    console.log(`[messenger:noop:interactive] -> ${to}: ${composed.bodyText}`);
    return { ok: true, noop: true };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildInteractiveButtonsPayload(to, composed)),
  });
  if (!res.ok) {
    const body = await res.text();
    if (isReengagementWindowError(body)) {
      console.warn(`WhatsApp interactive send to ${to} fell outside the 24h window — retrying as button template "${REMINDER_TEMPLATE_NAME}"`);
      return sendReminderButtonTemplate(to, composed, opts);
    }
    throw new Error(`WhatsApp interactive send failed (${res.status}): ${body}`);
  }
  return res.json();
}

// F2 — the approved-template counterpart to sendReminderButtons, the
// fallback used only when a reminder falls outside the 24h window (kept as
// the fallback rather than made primary specifically for cost — see the
// note at the top of this file). Approved by Meta (id 4422763491370778,
// category MARKETING — appeal to UTILITY pending, see the architecture
// doc). The template's own fixed copy (wrapper text + the two quick-reply
// buttons themselves) is baked into what Meta already approved — this
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
