// The LLM's one job: read raw input, return structured fields only. No
// confidence score, no routing decision, no reply wording — everything
// downstream is deterministic app code (see rules/ and pipeline/).

// A1 (read-back queries) — the bot needs to tell "create this" apart from
// "tell me what's already there" ("what's on tomorrow?", "מה יש לגאיה ביום
// שלישי?"), and that's genuine intent classification, not a keyword to
// match (same lesson as item 10's reminder-intent fix — see
// EXTRACTION_TOOL's own description below for the capture side of the same
// distinction). Modeled as two tools rather than one schema with an
// "intent" field so each shape only ever carries fields that make sense
// for it — a query has no title/color/icon to fill in, a capture has no
// date range to search. `tool_choice: 'any'` (see extract()) lets the
// model pick which one applies in the *same* call — still one LLM call
// per message, not two.
const QUERY_TOOL = {
  name: 'record_query',
  description:
    'Record a read-back question asking what is already on the calendar/tasks — the sender wants information, not to create or change anything.',
  input_schema: {
    type: 'object',
    properties: {
      date_from: { type: 'string', description: 'ISO 8601 date — first day of the range being asked about, resolved against the reference date (e.g. "tomorrow" -> that date).' },
      date_to: { type: 'string', description: 'ISO 8601 date — last day of the range. Same as date_from for a single day ("what\'s on tomorrow"); a real range for "this week"/"עד יום שישי" etc.' },
      person: {
        type: ['string', 'null'],
        description: 'Set only when the question is explicitly scoped to one person ("what does Gaia have Tuesday?", "מה יש לגאיה ביום שלישי?") — their name, matched the same way record_extraction\'s `person` is. null for a general, family-wide question ("what\'s on tomorrow?").',
      },
    },
    required: ['date_from', 'date_to', 'person'],
  },
};

// A2 (cancel/reschedule) — a third distinct intent alongside "create" and
// "what's already there": "change or remove something that already
// exists." `event_description` is deliberately free text, not a structured
// match — the real lookup (matching this against actual Calendar events,
// with disambiguation when more than one plausibly matches) is
// deterministic app code, not something to ask the model to resolve.
const MANAGEMENT_TOOL = {
  name: 'record_management',
  description:
    'Record a request to cancel or reschedule an event that already exists — "cancel dance class Thursday", "move it to 17:00", "בטלי את חוג הריקוד". Not for creating something new (use record_extraction) or asking what exists (use record_query).',
  input_schema: {
    type: 'object',
    properties: {
      management_action: { type: 'string', enum: ['cancel', 'reschedule'] },
      event_description: {
        type: 'string',
        description: 'Whatever the sender said to identify the event — title/activity words, who it\'s for, any date mentioned — verbatim enough to search real events with. Not a structured field, just the identifying text.',
      },
      date_hint: { type: ['string', 'null'], description: 'ISO 8601 date if one was given or implied ("Thursday", "מחר") to help narrow the search; null if the message gives no date at all.' },
      new_date: { type: ['string', 'null'], description: 'ISO 8601 date to move the event to — only for management_action "reschedule", only when a new date was actually given (may be the same as the original date if only the time changed).' },
      new_time: { type: ['string', 'null'], description: '24h HH:MM to move the event to — only for management_action "reschedule", only when a new time was actually given.' },
    },
    required: ['management_action', 'event_description', 'date_hint', 'new_date', 'new_time'],
  },
};

// C1 (standing rules taught in conversation) — a fourth intent alongside
// create/query/manage: "remember this permanently," not "act on this once."
// Per D-3's specific efficiency requirement, `rule_text` is an articulated,
// human-readable restatement of the rule produced in this SAME call — the
// bot shows it back for a yes/no confirmation, and that confirmation reply
// is matched directly against the pending DB record (see pipeline.js's
// resolveStandingRule), never sent through a second LLM call. Deliberately
// modeled as two narrow rule_kinds rather than a free-form
// conditions/actions blob: 'event_default' fills in one field whenever a
// future message's title/text contains a keyword (location/audience/
// duration/person defaults — covers most of the doc's own examples), and
// 'timing_param' changes a single named bot setting (currently only the
// daily briefing's send time, D-4). More elaborate rules (day-conditional
// ownership like "Shani handles Tuesdays, I handle Thursdays") are still
// recorded and shown back via rule_text for a human to read, but their
// *application* is out of scope for this pass — a known, stated limitation,
// not a silent gap (see standing_rules' own schema comment).
const RULE_TOOL = {
  name: 'record_rule',
  description:
    'Record a standing/general instruction the sender wants remembered and applied to every future matching message — phrased as "always"/"never"/"from now on"/a general policy, not a one-off event or question. E.g. "art therapy is always at the Rothschild clinic", "never remind me before 07:00", "send the daily briefing at 21:00", "anything I forward from the school group is for both kids". Not for creating one specific event (use record_extraction), asking what already exists (use record_query), or changing one specific existing event (use record_management).',
  input_schema: {
    type: 'object',
    properties: {
      rule_text: {
        type: 'string',
        description: 'A clear, complete, human-readable restatement of the rule, shown to the sender for a yes/no confirmation — e.g. "Art therapy will always be located at the Rothschild clinic."',
      },
      rule_kind: {
        type: 'string',
        enum: ['event_default', 'timing_param'],
        description: "'event_default' sets a default field value whenever a future message's title/text contains a keyword (location/audience/duration/person defaults). 'timing_param' changes a named bot setting (currently only the daily briefing's send time). Pick whichever the rule is actually closer to — a rule that doesn't cleanly fit either still gets recorded (rule_text alone is always meaningful), just without automatic application.",
      },
      field: {
        type: ['string', 'null'],
        enum: ['location', 'audience', 'duration_minutes', 'person', null],
        description: "rule_kind 'event_default' only — which field the default applies to.",
      },
      match_keyword: {
        type: ['string', 'null'],
        description: "rule_kind 'event_default' only — the word/phrase a future message's title or text should contain for this default to apply, e.g. 'art therapy'.",
      },
      value: {
        type: ['string', 'null'],
        description: "rule_kind 'event_default' only — the value to apply, e.g. 'Rothschild clinic', '50' (minutes), 'parent_only', or a family member's name.",
      },
      param_name: {
        type: ['string', 'null'],
        enum: ['briefing_send_time', null],
        description: "rule_kind 'timing_param' only — which setting this changes. Currently only 'briefing_send_time' exists.",
      },
      param_value: {
        type: ['string', 'null'],
        description: "rule_kind 'timing_param' only — the new value, e.g. '21:00' for briefing_send_time.",
      },
    },
    required: ['rule_text', 'rule_kind', 'field', 'match_keyword', 'value', 'param_name', 'param_value'],
  },
};

// A3 (multi-event extraction) — a forwarded school schedule or flyer often
// lists several dates at once ("swimming Mon & Wed, trip Friday"). The
// original schema only ever had room for one event, so extraction silently
// dropped everything after the first — same failure class as the
// already-fixed duration-loss bug, just at the message level instead of
// the event level. `additional_events` carries everything beyond the
// single primary item (still captured in the top-level fields exactly as
// before — fully backward compatible with every caller that only ever knew
// about a single flat capture). A reduced shape on purpose: no reminder
// fields (a personal reminder request applies to the sender's own primary
// ask, not usually to every date in a forwarded list) and no `category`
// (additional items are routed by a simple has-a-time check, not the
// family's own assessment rules — see pipeline.js's writeAdditionalEvent).
const ADDITIONAL_EVENT_ITEM = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: 'ISO 8601 date, e.g. 2026-08-20' },
    time: { type: ['string', 'null'], description: '24h HH:MM start time — null if this specific item gives no time (still recorded, just as a date-only task, not silently dropped).' },
    end_time: { type: ['string', 'null'], description: 'Same convention as the primary event\'s end_time — set only for an explicit end time or range.' },
    person: { type: ['string', 'null'] },
    location: { type: ['string', 'null'], description: "Same convention as the primary event's location field." },
    audience: { type: 'string', enum: ['family', 'parent_only'], description: "Same judgment as the primary event's audience field." },
    activity_icon: { type: 'string', description: 'Same one-emoji convention as the primary event\'s activity_icon field.' },
  },
  required: ['title', 'date', 'time', 'end_time', 'person', 'location', 'audience', 'activity_icon'],
};

const EXTRACTION_TOOL = {
  name: 'record_extraction',
  description:
    'Record the structured fields extracted from a forwarded family message that describes something to create — a real event, task, or reminder. Not for a question asking what already exists (use record_query), and not for cancelling/changing something that already exists (use record_management). When the message describes MORE than one distinct event or date (a weekly schedule, several dates in one flyer), record the first/main one in the top-level fields as usual and put every other one in additional_events — never drop a second, third, etc. one silently.',
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
      // B1 (location capture) — kept as a distinct field rather than left in
      // `title`, so it can be written straight to the Calendar event's own
      // native location field instead of getting stuffed into (and
      // cluttering) the title text, which is what happened before this
      // field existed.
      location: { type: ['string', 'null'], description: 'A physical place/address mentioned for this event, if any — e.g. "Rothschild clinic", "34 Herzl St". null when the message names no specific place.' },
      // B2 (recurring events) — most family scheduling is weekly (dance
      // every Tuesday, therapy every Monday); without this, the exact same
      // message has to be re-sent by hand every week. Same
      // intent-classification reasoning as reminder_requested: judge
      // whether the message describes a REPEATING commitment ("every
      // Tuesday", "weekly", Hebrew "כל שלישי") vs. a one-time occurrence
      // ("this Tuesday", "next Tuesday", a bare date) by meaning, not a
      // fixed trigger word. Google Calendar handles the actual repeating
      // behavior natively via RRULE once this is set — no repeat logic to
      // build downstream.
      recurrence: {
        type: ['string', 'null'],
        enum: ['weekly', 'biweekly', 'monthly', null],
        description: 'Set only when the message describes a genuinely repeating event, not a single occurrence. null (by far the most common case) for anything one-time, including a single date that merely happens to fall on a day of the week.',
      },
      reminder_requested: {
        type: 'boolean',
        // Real bug (item 10): this used to have no description of its own
        // at all, relying entirely on one line in the system prompt anchored
        // to a single English phrase ("remind me to..."). Roy's own
        // diagnosis: "handled as an intent-classification problem, not a
        // keyword match" — restated here too since the field-level
        // description is what the model weighs most directly when deciding
        // this specific value, in any phrasing, in any language.
        description:
          "true when the sender's underlying intent is a personal nudge/reminder at a future moment — they want to be personally pinged, not necessarily create something everyone sees on the shared calendar. Judge intent, not a fixed phrase: \"remind me to...\", \"don't let me forget to...\", \"ping me about...\", \"note to self...\", Hebrew \"תזכיר לי\"/\"שלא אשכח\", or any other natural phrasing expressing the same thing, all count. A plain statement of a scheduled event with no such request (\"soccer practice Thursday 5pm\") is false, even if it has a date and time.",
      },
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
      additional_events: {
        type: 'array',
        description: 'Every OTHER distinct event/date this message describes, beyond the single primary one captured in the fields above. Empty array [] when the message only describes one thing (the overwhelmingly common case) — only non-empty for something like a forwarded weekly schedule or a flyer listing several dates.',
        items: ADDITIONAL_EVENT_ITEM,
      },
    },
    required: ['title', 'date', 'time', 'end_time', 'person', 'category', 'location', 'recurrence', 'reminder_requested', 'reminder_datetime', 'audience', 'activity_icon', 'additional_events'],
  },
};

const SYSTEM_PROMPT = `You extract plain factual fields from a short family message — forwarded
WhatsApp text, a photographed flyer/schedule (read the image directly; it may be in any language,
including Hebrew — extract fields in whatever language the source uses, don't translate), or a
forwarded email. First decide which of the four tools actually fits: record_query when the sender
is asking what's already on the calendar ("what's on tomorrow?", "מה יש לגאיה ביום שלישי?", "any
plans Friday?") — a real question, not a statement; record_management when the sender wants to
cancel or change something that already exists ("cancel dance class Thursday", "move it to
17:00", "בטלי את"); record_rule when the sender is teaching a standing, general instruction to
apply going forward ("always"/"never"/"from now on"/a general policy — "art therapy is always at
the Rothschild clinic", "never remind me before 07:00") rather than describing one specific thing
to create, ask about, or change; record_extraction for a message describing something new to
create. Judge all of this
the same way as reminder_requested below: by intent, in any phrasing or language, not a fixed
trigger word. Do not decide what should happen with the
message beyond that one choice — only report what is literally present. If a field isn't stated,
use null. Set reminder_requested by judging the sender's actual
intent — do they want a personal nudge/reminder at a future moment? — not by matching a fixed
phrase; this can be asked for in many ways and in any language (see reminder_requested's own
description for real examples). Resolve relative dates ("Thursday",
"tomorrow") against the provided reference date. Set audience to 'parent_only' only when the message
is clearly not relevant to show a child (a parent's own appointment, a work meeting, "date night"
with no child involved); default to 'family' whenever it's unclear or the message concerns the
household generally — the kid dashboard hides 'parent_only' events entirely, so treat 'family' as
the safe default, not 'parent_only'. Also set activity_icon to exactly one emoji that best
represents the activity itself — pick freely, whatever genuinely fits (not from any fixed list),
independent of what language the message is written in; use 📌 only when the message is too vague
for any real icon to make sense. If the message plainly describes more than one distinct event or
date (a weekly schedule, several dates in one flyer), put the first one in the fields above and
every other one in additional_events (see its own description) — never silently drop one just
because the schema only has one set of top-level fields. Set location whenever a specific place is
named (an address, a clinic/venue name) — don't leave it folded into the title. Set recurrence only
for a genuinely repeating commitment ("every Tuesday", "weekly"), judged the same intent-based way
as reminder_requested — null for a one-time event, which is the default assumption whenever unclear.`;

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
 * @returns {Promise<{type:'capture',title:string|null,date:string|null,time:string|null,end_time:string|null,person:string|null,category:string|null,location:string|null,recurrence:string|null,reminder_requested:boolean,reminder_datetime:string|null,audience:'family'|'parent_only',activity_icon:string,additional_events:object[]} | {type:'query',date_from:string,date_to:string,person:string|null} | {type:'management',management_action:'cancel'|'reschedule',event_description:string,date_hint:string|null,new_date:string|null,new_time:string|null} | {type:'rule',rule_text:string,rule_kind:'event_default'|'timing_param',field:string|null,match_keyword:string|null,value:string|null,param_name:string|null,param_value:string|null}>}
 *   `type` distinguishes a capture (create something) from a read-back
 *   query (A1), a cancel/reschedule request (A2), or a standing-rule
 *   proposal (C1) — callers that only ever handled captures before this can
 *   keep treating a missing/`'capture'` type exactly as before; every
 *   original capture field is still present at the top level, unchanged.
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
      tools: [EXTRACTION_TOOL, QUERY_TOOL, MANAGEMENT_TOOL, RULE_TOOL],
      // 'any' (not 'tool'/name-forced, not 'auto') — forces exactly one
      // tool call every time (never a free-text non-tool reply, same
      // guarantee the old forced single-tool call had), but lets the model
      // choose *which* of the four tools actually fits this message.
      tool_choice: { type: 'any' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM extraction failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const toolUse = data.content?.find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('LLM response did not include the expected tool call.');
  const TYPE_BY_TOOL = { record_query: 'query', record_management: 'management', record_rule: 'rule' };
  const type = TYPE_BY_TOOL[toolUse.name] ?? 'capture';
  return { ...toolUse.input, type };
}
