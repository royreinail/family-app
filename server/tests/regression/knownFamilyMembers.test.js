// Regression test for a real bug: "קניות עם שי לי, היום בשעה 14:00"
// ("Shopping with Shai Lee, today at 2pm") created an event titled
// "Shopping with Shai" instead of recognizing Shai as a real, pre-defined
// family member — so `person` never got set, which meant color-matching
// (resolveEventColorId) had nothing to match against either. Root cause,
// per Roy's own diagnosis: webhook.js already fetched the family's real
// members but never passed their names into the extraction call at all,
// so the LLM had no way to know who counted as a known name versus just
// a word in the sentence. Fixed in llm.js's buildSystemPrompt (the pure
// part of extract() — the actual API call, like every other real LLM/
// Calendar call in this codebase, isn't unit-tested).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt } from '../../src/integrations/llm.js';

test('buildSystemPrompt lists known family members by name when given any', () => {
  const prompt = buildSystemPrompt(['Roy', 'Shai', 'Mia']);
  assert.match(prompt, /Known family members: Roy, Shai, Mia/);
  assert.match(prompt, /set `person` to their exact/);
});

test('buildSystemPrompt is unchanged when no family members are given', () => {
  const withoutNames = buildSystemPrompt([]);
  const withUndefined = buildSystemPrompt(undefined);
  assert.doesNotMatch(withoutNames, /Known family members/);
  assert.equal(withoutNames, withUndefined);
});
