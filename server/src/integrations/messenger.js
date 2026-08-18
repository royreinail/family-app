// Thin boundary around the messaging channel (future-proofing item 5).
// Pipeline code calls messenger.send(...) — never the Meta Graph API
// directly inline. Phase 3's group-participant bot needs a different
// connection model entirely; keeping this boundary thin is what lets that
// be a second implementation later instead of a rewrite.
const GRAPH_API_VERSION = 'v20.0';

export async function send(to, text, { phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID, token = process.env.WHATSAPP_SYSTEM_USER_TOKEN } = {}) {
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
    throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
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
