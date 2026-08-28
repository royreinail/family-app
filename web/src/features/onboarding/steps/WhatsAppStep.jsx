import { useEffect, useState } from 'react';
import { color, ink, weight } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PrimaryButton from '../../../components/PrimaryButton.jsx';
import { getBotConfig, confirmBotConfig, getFamilyMembers } from '../../../api/client.js';

export const STEP_INDEX = 4;

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
  const [confirming, setConfirming] = useState(false);
  // Distinguishes "still loading" from "loaded, genuinely empty" from
  // "failed to load" — the picker below used to be gated on nothing but
  // `members.length > 0`, so any of those three looked identical: no
  // picker, no explanation. A fetch that rejects (network hiccup, a
  // session edge case) previously left `members` silently `[]` forever
  // with zero indication why — same failure shape as "you have no family
  // members," but a different, actionable fix.
  const [membersState, setMembersState] = useState('loading');

  useEffect(() => {
    getBotConfig().then((c) => {
      setConfig(c);
      // Pre-fill so relinking an already-connected number (e.g. after this
      // fix shipped, for a number confirmed before it existed) doesn't
      // require retyping it — only meaningful when there's exactly one.
      if (c.acceptedChatIds?.length === 1) setMyNumber(c.acceptedChatIds[0]);
    });
    getFamilyMembers()
      .then(({ members: list }) => {
        setMembers(list);
        setMembersState('loaded');
        const parents = list.filter((m) => m.is_parent);
        if (parents.length === 1) setMemberId(parents[0].id);
      })
      .catch((err) => {
        console.error('Failed to load family members for WhatsApp linking', err);
        setMembersState('failed');
      });
  }, []);

  async function confirm() {
    if (!myNumber.trim() || !memberId) return;
    setConfirming(true);
    const updated = await confirmBotConfig(myNumber.trim(), memberId);
    setConfig((c) => ({ ...c, connected: updated.connected, acceptedChatIds: updated.acceptedChatIds, senderMappings: updated.senderMappings }));
    setConfirming(false);
  }

  const connected = config?.connected;
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
        <PrimaryButton onClick={confirm} disabled={confirming || !myNumber.trim() || !memberId} tone="green">
          {connected ? 'Save' : 'I sent a message'}
        </PrimaryButton>
        {connected && (
          <PrimaryButton onClick={() => (editMode ? onDone?.() : onNext())} tone="green">Continue</PrimaryButton>
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
