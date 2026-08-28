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
      time: { type: ['string', 'null'], description: '24h HH:MM start time, e.g. 16:00' },
      end_time: {
        type: ['string', 'null'],
        description: '24h HH:MM — set ONLY when the message gives an explicit end time or a time range (e.g. "9:00-18:00", "3pm to 5pm", "2-4pm"). Leave null for a single point-in-time event; a sensible default duration is applied downstream when this is null.',
      },
      person: { type: ['string', 'null'] },
      category: { type: ['string', 'null'] },
      reminder_requested: { type: 'boolean' },
      reminder_datetime: { type: ['string', 'null'], description: 'ISO 8601 datetime, when reminder_requested is true' },
      audience: {
        type: 'string',
        enum: ['family', 'parent_only'],
        description: "'family' unless the message is clearly only relevant to a parent (a personal appointment, work meeting, 'date night' with no child involved, first-person language about the sender alone). Default to 'family' whenever unclear.",
      },
      activity_icon: {
        type: 'string',
        // Free choice, not a fixed enum (Roy's call, live-testing feedback:
        // a small hardcoded category list gatekept what could get a real
        // icon at all — "ערב סרט"/movie night had nowhere to go but the
        // pushpin simply because no one had thought to add a "movie"
        // category yet). Costs nothing extra — it's the same required field
        // in the same single extraction call as everything else, just an
        // emoji instead of a category word, not a second LLM call.
        description: "Exactly one emoji that best represents this specific activity, regardless of what language the message is in (a dance class -> 💃, a movie night -> 🎬, a dentist visit -> 🦷, a birthday -> 🎉) — pick whatever genuinely fits best, not from a fixed list. Use 📌 only when the message is too vague for any real icon to make sense.",
      },
    },
    required: ['title', 'date', 'time', 'end_time', 'person', 'category', 'reminder_requested', 'reminder_datetime', 'audience', 'activity_icon'],
  },
};

const SYSTEM_PROMPT = `You extract plain factual fields from a short family message — forwarded
WhatsApp text, a photographed flyer/schedule (read the image directly; it may be in any language,
including Hebrew — extract fields in whatever language the source uses, don't translate), or a
forwarded email. Do not decide what should happen with the message — only report what is literally
present. If a field isn't stated, use null. Only set reminder_requested to true if the message
explicitly asks to be reminded (e.g. "remind me to..."). Resolve relative dates ("Thursday",
"tomorrow") against the provided reference date. Set audience to 'parent_only' only when the message
is clearly not relevant to show a child (a parent's own appointment, a work meeting, "date night"
with no child involved); default to 'family' whenever it's unclear or the message concerns the
household generally — the kid dashboard hides 'parent_only' events entirely, so treat 'family' as
the safe default, not 'parent_only'. Also set activity_icon to exactly one emoji that best
represents the activity itself — pick freely, whatever genuinely fits (not from any fixed list),
independent of what language the message is written in; use 📌 only when the message is too vague
for any real icon to make sense.`;

// Exported (unlike the actual API call, which is never unit-tested — same
// reasoning as dashboard.js's real Calendar API calls) since this part is
// pure and worth covering directly: it's the actual fix for a real bug
// (family member names never reaching the LLM at all).
export function buildSystemPrompt(familyMemberNames) {
  if (!familyMemberNames?.length) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}

Known family members: ${familyMemberNames.join(', ')}. If the message clearly refers to one of
them (in any language — a name doesn't change across languages), set \`person\` to their exact
name as listed here, not however it happened to appear in the message. When \`person\` already
captures who the event is for, keep \`title\` focused on the activity itself rather than repeating
their name in it (e.g. prefer "Shopping" over "Shopping with Shai" when person is "Shai").`;
}

/**
 * @param {string} rawInput - message text, or a caption/empty string when `opts.image` is set
 * @param {{referenceDate?: string, model?: string, image?: {base64: string, mimeType: string}, familyMemberNames?: string[]}} [opts]
 * @returns {Promise<{title:string|null,date:string|null,time:string|null,end_time:string|null,person:string|null,category:string|null,reminder_requested:boolean,reminder_datetime:string|null,audience:'family'|'parent_only',activity_icon:string}>}
 */
export async function extract(rawInput, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot call the extraction LLM.');
  }
  const model = opts.model || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const referenceDate = opts.referenceDate || new Date().toISOString().slice(0, 10);

  const textBlock = {
    type: 'text',
    text: `Reference date: ${referenceDate}\n\nMessage:\n${rawInput || '(no text — read the attached photo for the event/task details)'}`,
  };
  const content = opts.image
    ? [{ type: 'image', source: { type: 'base64', media_type: opts.image.mimeType, data: opts.image.base64 } }, textBlock]
    : textBlock.text;

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
      system: buildSystemPrompt(opts.familyMemberNames),
      messages: [{ role: 'user', content }],
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
