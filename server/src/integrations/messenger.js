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
// template send. Until WHATSAPP_REMINDER_TEMPLATE_NAME is actually created
// and Meta-approved (see family-app-architecture.md for the exact template
// text to submit), this fallback itself fails too — a normal, logged error,
// same as before this existed, not a new failure mode.
const REENGAGEMENT_ERROR_CODE = 131047;
const REMINDER_TEMPLATE_NAME = process.env.WHATSAPP_REMINDER_TEMPLATE_NAME || 'reminder_notification';
const REMINDER_TEMPLATE_LANGUAGE = process.env.WHATSAPP_REMINDER_TEMPLATE_LANGUAGE || 'en_US';

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

export function isReengagementWindowError(rawBody) {
  try {
    return JSON.parse(rawBody)?.error?.code === REENGAGEMENT_ERROR_CODE;
  } catch {
    return false;
  }
}

// A pre-approved template with exactly one body variable — see
// family-app-architecture.md for the exact text submitted for Meta's
// review. `bodyText` becomes {{1}} verbatim (e.g. "Reminder: pick up the
// dry cleaning"), so the template's own fixed copy deliberately carries no
// "Reminder:" prefix of its own — avoids double-prefixing when
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
        components: [{ type: 'body', parameters: [{ type: 'text', text: bodyText }] }],
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
