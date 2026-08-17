import { useEffect, useState } from 'react';
import { color, ink, weight } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PrimaryButton from '../../../components/PrimaryButton.jsx';
import { getBotConfig, confirmBotConfig } from '../../../api/client.js';

export const STEP_INDEX = 4;

/** Reused in Settings Home > WhatsApp Connection (edit mode). */
export default function WhatsAppStep({ totalSteps, onNext, editMode = false, onDone }) {
  const [config, setConfig] = useState(null);
  const [myNumber, setMyNumber] = useState('');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    getBotConfig().then(setConfig);
  }, []);

  async function confirm() {
    if (!myNumber.trim()) return;
    setConfirming(true);
    const updated = await confirmBotConfig(myNumber.trim());
    setConfig((c) => ({ ...c, connected: updated.connected, acceptedChatIds: updated.acceptedChatIds }));
    setConfirming(false);
  }

  const connected = config?.connected;

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

        {connected ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <span className="ms" style={{ fontSize: 22, color: color.accentWhatsapp }}>check_circle</span>
            <div style={{ font: `${weight.bold} 15px/1.3 Nunito, sans-serif`, color: ink(0.55) }}>Connected</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <input
              value={myNumber}
              onChange={(e) => setMyNumber(e.target.value)}
              placeholder="Your WhatsApp number, e.g. +15551234567"
              style={{ font: `${weight.semibold} 15px/1.3 Nunito, sans-serif`, padding: '12px 16px', borderRadius: 16, border: `1px solid ${ink(0.15)}`, width: 260, textAlign: 'center' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <div style={{ display: 'flex', gap: 5 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#c9a24a', animation: 'waitDot 1.4s ease-in-out infinite' }} />
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#c9a24a', animation: 'waitDot 1.4s ease-in-out .2s infinite' }} />
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#c9a24a', animation: 'waitDot 1.4s ease-in-out .4s infinite' }} />
              </div>
              <div style={{ font: `${weight.bold} 15px/1.3 Nunito, sans-serif`, color: ink(0.45) }}>Waiting for your first message</div>
            </div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        {connected ? (
          <PrimaryButton onClick={() => (editMode ? onDone?.() : onNext())} tone="green">Continue</PrimaryButton>
        ) : (
          <PrimaryButton onClick={confirm} disabled={confirming || !myNumber.trim()} tone="green">I sent a message</PrimaryButton>
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
