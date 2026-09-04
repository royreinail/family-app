// E1 (voice notes as input, SHELVED — no transcription path exists;
// see webhook.js's own comment for why) — resolveAudioMediaRef is still
// what recognizes a voice note so it gets its own honest decline reply
// instead of being lumped into the generic "unsupported type" message.
// Extracted for real test coverage the same way resolveImageMediaRef
// already is (item 2's precedent): the actual WhatsApp API call it feeds
// into isn't unit-tested, same as every other real integration call in
// this codebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAudioMediaRef } from '../../src/routes/webhook.js';

test('resolveAudioMediaRef recognizes a voice note / audio message', () => {
  const message = { type: 'audio', audio: { id: 'media-321', mime_type: 'audio/ogg; codecs=opus', voice: true } };
  assert.deepEqual(resolveAudioMediaRef(message), { id: 'media-321', mimeType: 'audio/ogg; codecs=opus' });
});

test('resolveAudioMediaRef recognizes a regular shared audio file the same way (not just a recorded voice note)', () => {
  const message = { type: 'audio', audio: { id: 'media-654', mime_type: 'audio/mpeg' } };
  assert.deepEqual(resolveAudioMediaRef(message), { id: 'media-654', mimeType: 'audio/mpeg' });
});

test('resolveAudioMediaRef ignores other message types entirely', () => {
  assert.equal(resolveAudioMediaRef({ type: 'text', text: { body: 'hi' } }), null);
  assert.equal(resolveAudioMediaRef({ type: 'image', image: { id: 'media-1' } }), null);
  assert.equal(resolveAudioMediaRef(undefined), null);
  assert.equal(resolveAudioMediaRef({ type: 'audio', audio: {} }), null, 'no real media id — nothing to resolve');
});
