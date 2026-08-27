// Regression coverage for the "Known gap" flagged in the architecture doc:
// a reminder fired outside the 24h customer-service window gets rejected by
// Meta (error code 131047, "re-engagement") since a freeform text message
// only works inside that window — fixed by messenger.js catching exactly
// that rejection and retrying once as a pre-approved template send. Only
// the pure recognizer is unit-tested here — the real Graph API calls around
// it aren't, same as every other real integration call in this codebase
// (isReauthRequiredError for Calendar is the direct precedent).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isReengagementWindowError } from '../../src/integrations/messenger.js';

test('isReengagementWindowError recognizes the real Meta error shape (error code 131047)', () => {
  const body = JSON.stringify({
    error: {
      message: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
      type: 'OAuthException',
      code: 131047,
      error_subcode: 2018278,
    },
  });
  assert.equal(isReengagementWindowError(body), true);
});

test('isReengagementWindowError returns false for an unrelated WhatsApp API error', () => {
  const body = JSON.stringify({ error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } });
  assert.equal(isReengagementWindowError(body), false);
});

test('isReengagementWindowError returns false for a non-JSON or malformed body', () => {
  assert.equal(isReengagementWindowError('not json'), false);
  assert.equal(isReengagementWindowError(''), false);
  assert.equal(isReengagementWindowError('{}'), false);
});
