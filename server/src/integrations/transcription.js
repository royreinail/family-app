// E1 (voice notes as input) — self-contained per the enhancement backlog:
// transcribe once, then hand the resulting text to the EXISTING extraction
// pipeline completely unchanged (webhook.js just sets `text` from this
// before calling handleIncomingMessage, same as an image's caption already
// does — see resolveImageMediaRef's own pattern).
//
// No dedicated speech-to-text credential is provisioned for this
// deployment (Anthropic's own Messages API has no audio-input content type
// as of this writing — only text/image/PDF — so this can't reuse
// ANTHROPIC_API_KEY the way image capture reuses it for vision). Uses
// OpenAI's Whisper transcription endpoint, the standard choice for this,
// gated behind its own OPENAI_API_KEY. Deliberately throws a clear, typed
// error when that key isn't set rather than attempting a doomed call —
// webhook.js catches this and sends an honest "can't do voice notes yet"
// reply instead of silence (same "every message gets at least some
// response" philosophy already established there for a failed image
// download). The moment a real key is added to the deployment, voice notes
// start working with no further code change — this was flagged explicitly
// to Roy as a real, live dependency this pass could not provision itself
// (adding a paid API credential is outside what can be done without the
// account holder's own action).
export async function transcribe({ base64, mimeType }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('No speech-to-text credential configured (OPENAI_API_KEY) — cannot transcribe voice notes yet.');
  }
  const buffer = Buffer.from(base64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), 'voice-note.ogg');
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Transcription failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.text || '';
}
