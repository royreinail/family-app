// Regression coverage for backlog item 2 (image extraction "wasn't able to
// manage it at all"). Root cause: WhatsApp represents a shared photo two
// different ways depending on how the sender sent it -- the native "image"
// message type, or a "document" whose mime_type happens to be an image
// (common when someone deliberately avoids WhatsApp's compression to keep
// flyer text legible, which is very plausibly what happened with the real
// flyer image that triggered this). webhook.js only ever handled the first
// shape, so a document-shared photo silently got neither an image nor any
// text at all -- resolveImageMediaRef is the pure fix, extracted for real
// test coverage since the actual webhook route (like every other real
// WhatsApp/Calendar/LLM call in this codebase) isn't unit-tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveImageMediaRef } from '../../src/routes/webhook.js';

test('resolveImageMediaRef recognizes a native image message', () => {
  const message = { type: 'image', image: { id: 'media-123', caption: 'Flyer' } };
  assert.deepEqual(resolveImageMediaRef(message), { id: 'media-123', caption: 'Flyer' });
});

test('resolveImageMediaRef recognizes an image shared as a document (the actual bug)', () => {
  const message = { type: 'document', document: { id: 'media-456', mime_type: 'image/png', caption: 'Commanders Day flyer' } };
  assert.deepEqual(resolveImageMediaRef(message), { id: 'media-456', caption: 'Commanders Day flyer' });
});

test('resolveImageMediaRef ignores a non-image document (e.g. a PDF)', () => {
  const message = { type: 'document', document: { id: 'media-789', mime_type: 'application/pdf' } };
  assert.equal(resolveImageMediaRef(message), null);
});

test('resolveImageMediaRef ignores other message types entirely', () => {
  assert.equal(resolveImageMediaRef({ type: 'text', text: { body: 'hi' } }), null);
  assert.equal(resolveImageMediaRef({ type: 'audio', audio: { id: 'media-999' } }), null);
  assert.equal(resolveImageMediaRef({ type: 'reaction', reaction: { emoji: '👍' } }), null);
  assert.equal(resolveImageMediaRef(undefined), null);
});

test('resolveImageMediaRef handles a document/image with no caption', () => {
  assert.deepEqual(resolveImageMediaRef({ type: 'image', image: { id: 'media-1' } }), { id: 'media-1', caption: undefined });
});
