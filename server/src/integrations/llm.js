// The LLM's one job: read raw input, return structured fields only. No
// confidence score, no routing decision, no reply wording — everything
// downstream is deterministic app code (see rules/ and pipeline/).
const EXTRACTION_TOOL = {
  name: 'record_extraction',
  description: 'Record the structured fields extracted from a forwarded family message.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: ['string', 'null'] },
      date: { type: ['string', 'null'], description: 'ISO 8601 date, e.g. 2026-08-20' },
      time: { type: ['string', 'null'], description: '24h HH:MM, e.g. 16:00' },
      person: { type: ['string', 'null'] },
      category: { type: ['string', 'null'] },
      reminder_requested: { type: 'boolean' },
      reminder_datetime: { type: ['string', 'null'], description: 'ISO 8601 datetime, when reminder_requested is true' },
    },
    required: ['title', 'date', 'time', 'person', 'category', 'reminder_requested', 'reminder_datetime'],
  },
};

const SYSTEM_PROMPT = `You extract plain factual fields from a short family message (a forwarded
WhatsApp text, flyer photo caption, or forwarded email). Do not decide what should happen with the
message — only report what is literally present. If a field isn't stated, use null. Only set
reminder_requested to true if the message explicitly asks to be reminded (e.g. "remind me to...").
Resolve relative dates ("Thursday", "tomorrow") against the provided reference date.`;

/**
 * @param {string} rawInput
 * @param {{referenceDate?: string, model?: string}} [opts]
 * @returns {Promise<{title:string|null,date:string|null,time:string|null,person:string|null,category:string|null,reminder_requested:boolean,reminder_datetime:string|null}>}
 */
export async function extract(rawInput, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot call the extraction LLM.');
  }
  const model = opts.model || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const referenceDate = opts.referenceDate || new Date().toISOString().slice(0, 10);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Reference date: ${referenceDate}\n\nMessage:\n${rawInput}` },
      ],
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'record_extraction' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM extraction failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const toolUse = data.content?.find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('LLM response did not include the expected tool call.');
  return toolUse.input;
}
