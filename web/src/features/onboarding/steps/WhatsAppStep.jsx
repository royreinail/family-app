import { useEffect, useState } from 'react';
import { color, ink, weight } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PrimaryButton from '../../../components/PrimaryButton.jsx';
import { getBotConfig, confirmBotConfig, getFamilyMembers } from '../../../api/client.js';

export const STEP_INDEX = 4;

// Mirrors botConfig.js's normalizePhone server-side — senderMappings comes
// back with bare-digit identifiers (matching what WhatsApp's webhook
// actually sends), while `myNumber` is whatever human-friendly format was
// typed ("+1 555-123-4567"). Compare on digits only, same as the server does.
function normalizePhone(value) {
  return (value || '').replace(/\D/g, '');
}

/** Reused in Settings Home > WhatsApp Connection (edit mode). */
export default function WhatsAppStep({ totalSteps, onNext, editMode = false, onDone }) {
  const [config, setConfig] = useState(null);
  const [members, setMembers] = useState([]);
  const [myNumber, setMyNumber] = useState('');
  // Item 6's forwarded-sender default (and its color assignment) depends on
  // knowing which family member a connected number actually belongs to —
  // real bug: this was never asked at all, so that default silently never
  // fired for any real message. Defaults to the sole parent when there's
  // only one, since that's who's almost always doing this step.
  const [memberId, setMemberId] = useState('');
  // What's actually persisted right now — the baseline the form is
  // compared against to decide whether there's anything to save at all
  // (Roy's call: only show Save when the form actually differs from what's
  // saved, instead of always offering a button that may do nothing).
  const [savedNumber, setSavedNumber] = useState('');
  const [savedMemberId, setSavedMemberId] = useState('');
  const [confirming, setConfirming] = useState(false);
  // The "Save Changes" rule (applied consistently across Settings screens):
  // one bottom button whose label tracks state — "Continue" when clean
  // (just navigates, no network call), "Save Changes" when dirty (saves,
  // then navigates in the same tap, replacing the old separate Save +
  // Continue pair). Only 'error' is still shown on this screen itself —
  // a successful save always leaves the screen (the navigation *is* the
  // confirmation), so there's nothing to show once it's worked. A failed
  // save has to stay put and say so, or it's a stuck disabled button with
  // no explanation (the original bug here).
  const [saveState, setSaveState] = useState('idle'); // 'idle' | 'error'
  // Distinguishes "still loading" from "loaded, genuinely empty" from
  // "failed to load" — the picker below used to be gated on nothing but
  // `members.length > 0`, so any of those three looked identical: no
  // picker, no explanation. A fetch that rejects (network hiccup, a
  // session edge case) previously left `members` silently `[]` forever
  // with zero indication why — same failure shape as "you have no family
  // members," but a different, actionable fix.
  const [membersState, setMembersState] = useState('loading');

  useEffect(() => {
    // Awaited together (not two independent .then() chains) so the saved
    // baseline is computed once both are in — racing them separately meant
    // whichever resolved last silently decided memberId, which could
    // clobber a real existing mapping with the "sole parent" guess.
    Promise.all([
      getBotConfig(),
      getFamilyMembers()
        .then((r) => ({ ok: true, list: r.members }))
        .catch((err) => ({ ok: false, err })),
    ]).then(([c, membersResult]) => {
      setConfig(c);

      if (!membersResult.ok) {
        console.error('Failed to load family members for WhatsApp linking', membersResult.err);
        setMembersState('failed');
        return;
      }
      const list = membersResult.list;
      setMembers(list);
      setMembersState('loaded');

      // Pre-fill so relinking an already-connected number (e.g. after this
      // fix shipped, for a number confirmed before it existed) doesn't
      // require retyping it — only meaningful when there's exactly one.
      const singleNumber = c.acceptedChatIds?.length === 1 ? c.acceptedChatIds[0] : '';
      if (singleNumber) {
        setMyNumber(singleNumber);
        setSavedNumber(singleNumber);
      }
      // Prefer the number's *actual* existing link (normalized digits, same
      // comparison the server uses) over the "sole parent" guess — a real
      // mapping is a fact, the guess is just a reasonable default absent one.
      const existingMapping = c.senderMappings?.find(
        (m) => m.externalIdentifier === normalizePhone(singleNumber)
      );
      const parents = list.filter((m) => m.is_parent);
      const initialMemberId = existingMapping?.familyMemberId || (parents.length === 1 ? parents[0].id : '');
      setMemberId(initialMemberId);
      if (existingMapping) setSavedMemberId(existingMapping.familyMemberId);
    });
  }, []);

  async function confirm() {
    if (!myNumber.trim() || !memberId) return;
    // Captured before this save resolves — deciding what happens *after*
    // saving needs to know what was true *before* it, not the value
    // `connected` will hold once state updates land mid-flight.
    const wasAlreadyConnected = connected;
    setConfirming(true);
    setSaveState('idle');
    try {
      const updated = await confirmBotConfig(myNumber.trim(), memberId);
      setConfig((c) => ({ ...c, connected: updated.connected, acceptedChatIds: updated.acceptedChatIds, senderMappings: updated.senderMappings }));
      // Move the baseline to what was just saved — the button's own label
      // (Continue vs. Save Changes) reads directly off this, so moving it
      // is what makes the button correctly stop offering to save again.
      setSavedNumber(myNumber.trim());
      setSavedMemberId(memberId);
      if (wasAlreadyConnected) {
        // "Save Changes" on an existing connection: save-and-return is one
        // action, same as every other Settings screen under this rule.
        editMode ? onDone?.() : onNext();
      }
      // First-time connect: deliberately stays put and shows the confirmed
      // "Connected" state instead of immediately leaving — a real milestone
      // worth seeing, not just a field edit. The button becomes "Continue"
      // on its own once `connected`/the saved baseline update above land.
    } catch (err) {
      console.error('Failed to save WhatsApp connection', err);
      setSaveState('error');
    } finally {
      setConfirming(false);
    }
  }

  const connected = config?.connected;
  // Roy's call: only offer Save once there's actually something to save —
  // not connected at all yet is its own case (handled separately below,
  // "I sent a message"), always offered when the fields are filled in.
  const isDirty = myNumber.trim() !== savedNumber || memberId !== savedMemberId;
  const memberPicker =
    members.length > 0 ? (
      <select
        value={memberId}
        onChange={(e) => setMemberId(e.target.value)}
        style={{ font: `${weight.semibold} 15px/1.3 Nunito, sans-serif`, padding: '12px 16px', borderRadius: 16, border: `1px solid ${ink(0.15)}`, width: 260, textAlign: 'center' }}
      >
        <option value="" disabled>Whose number is this?</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    ) : membersState === 'failed' ? (
      <div style={{ font: `${weight.semibold} 14px/1.4 Nunito, sans-serif`, color: '#b3564a', textAlign: 'center', maxWidth: 260 }}>
        Couldn't load family members — reload this page and try again.
      </div>
    ) : membersState === 'loaded' ? (
      <div style={{ font: `${weight.semibold} 14px/1.4 Nunito, sans-serif`, color: ink(0.45), textAlign: 'center', maxWidth: 260 }}>
        Add a family member first (Settings → Family Members), then come back here to link their number.
      </div>
    ) : null;

  return (
    <>
      {!editMode && <ProgressDots total={totalSteps} current={STEP_INDEX} />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 30, marginTop: -20 }}>
        <div style={{ alignSelf: 'center', width: 96, height: 96, borderRadius: '50%', background: color.accentWhatsappTint, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="ms" style={{ fontSize: 56, color: color.accentWhatsapp }}>chat</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ font: `${weight.heavy} 32px/1.2 Nunito, sans-serif`, color: color.ink, textAlign: 'center', letterSpacing: '-.4px' }}>Add events by message</div>
          <div style={{ font: `${weight.semibold} 18px/1.5 Nunito, sans-serif`, color: ink(0.52), textAlign: 'center' }}>
            Text us "dentist Tuesday 4pm" and it lands on the board.
          </div>
        </div>

        {config && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{ font: `${weight.heavy} 30px/1.2 Nunito, sans-serif`, color: color.ink, letterSpacing: '.5px' }}>
              {config.botDisplayNumber || 'Set WHATSAPP_DISPLAY_NUMBER'}
            </div>
          </div>
        )}

        {connected && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <span className="ms" style={{ fontSize: 22, color: color.accentWhatsapp }}>check_circle</span>
            <div style={{ font: `${weight.bold} 15px/1.3 Nunito, sans-serif`, color: ink(0.55) }}>Connected</div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <input
            value={myNumber}
            onChange={(e) => setMyNumber(e.target.value)}
            placeholder="Your WhatsApp number, e.g. +15551234567"
            style={{ font: `${weight.semibold} 15px/1.3 Nunito, sans-serif`, padding: '12px 16px', borderRadius: 16, border: `1px solid ${ink(0.15)}`, width: 260, textAlign: 'center' }}
          />
          {memberPicker}
          {!connected && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <div style={{ display: 'flex', gap: 5 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#c9a24a', animation: 'waitDot 1.4s ease-in-out infinite' }} />
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#c9a24a', animation: 'waitDot 1.4s ease-in-out .2s infinite' }} />
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#c9a24a', animation: 'waitDot 1.4s ease-in-out .4s infinite' }} />
              </div>
              <div style={{ font: `${weight.bold} 15px/1.3 Nunito, sans-serif`, color: ink(0.45) }}>Waiting for your first message</div>
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        {/* The Save Changes rule, one button: not connected yet -> "I sent
            a message" (its own milestone, stays put on success to show the
            Connected state rather than immediately leaving); connected and
            clean -> "Continue" (just navigates, nothing to save); connected
            and dirty -> "Save Changes" (saves, then navigates in one tap). */}
        <PrimaryButton
          onClick={connected && !isDirty ? () => (editMode ? onDone?.() : onNext()) : confirm}
          disabled={confirming || !myNumber.trim() || !memberId}
          tone="green"
        >
          {confirming ? 'Saving…' : !connected ? 'I sent a message' : isDirty ? 'Save Changes' : 'Continue'}
        </PrimaryButton>
        {saveState === 'error' && (
          <div style={{ font: `${weight.bold} 14px/1.3 Nunito, sans-serif`, color: '#b3564a', textAlign: 'center' }}>
            Couldn't save — try again
          </div>
        )}
        {!editMode && (
          <button onClick={onNext} style={{ background: 'none', border: 'none', cursor: 'pointer', font: `${weight.bold} 15px/1 Nunito, sans-serif`, color: ink(0.42) }}>
            Skip and finish setup
          </button>
        )}
      </div>
    </>
  );
}
