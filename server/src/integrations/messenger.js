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
