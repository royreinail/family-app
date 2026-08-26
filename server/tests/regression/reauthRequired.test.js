// Regression coverage for a real production bug: the kid dashboard showed
// a generic "couldn't load, try again in a bit" whenever Google Calendar
// failed, including when the actual cause was a dead refresh token
// (GaxiosError: invalid_grant -- confirmed from real Railway logs). That's
// not transient like a genuine API hiccup: no amount of retrying fixes it,
// only reconnecting does. isReauthRequiredError (calendar.js) is what lets
// dashboard.js tell these two cases apart and give the frontend something
// actionable for the one that's actually fixable by the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isReauthRequiredError } from '../../src/integrations/calendar.js';

test('isReauthRequiredError recognizes the real GaxiosError shape (response.data.error)', () => {
  const err = { response: { data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } };
  assert.equal(isReauthRequiredError(err), true);
});

test('isReauthRequiredError recognizes it from the error message alone (as logged in production)', () => {
  const err = new Error('invalid_grant');
  err.message = 'GaxiosError: invalid_grant';
  assert.equal(isReauthRequiredError(err), true);
});

test('isReauthRequiredError returns false for an unrelated/transient error', () => {
  assert.equal(isReauthRequiredError(new Error('ECONNRESET')), false);
  assert.equal(isReauthRequiredError({ response: { data: { error: 'rateLimitExceeded' } } }), false);
  assert.equal(isReauthRequiredError(null), false);
  assert.equal(isReauthRequiredError(undefined), false);
});
