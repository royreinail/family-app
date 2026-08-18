import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { color, ink, weight } from '../../theme/tokens.js';
import PhoneFrame from '../../components/PhoneFrame.jsx';
import PinPad from '../../components/PinPad.jsx';
import { verifyPin, forgotPin } from '../../api/client.js';

// PIN entry screen gating Settings Home. Reused as the identity check both
// for normal entry and — combined with "Forgot PIN" — for PIN recovery,
// which re-uses the already-signed-in Google session rather than a separate
// security-question/email-code flow (the caller only reaches this route at
// all if requireFamily's session check already passed).
export default function PinGate({ onVerified }) {
  const [recovering, setRecovering] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(pin) {
    const { ok } = await verifyPin(pin);
    if (ok) onVerified();
    return ok;
  }

  async function handleForgot() {
    await forgotPin();
    setRecovering(true);
    onVerified({ setNewPin: true });
  }

  return (
    <PhoneFrame onBack={() => navigate('/dashboard')}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: color.accentSettingsTint, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 22 }}>
            <span className="ms" style={{ fontSize: 34, color: color.accentSettings }}>lock</span>
          </div>
          <div style={{ font: `${weight.heavy} 26px/1.2 Nunito, sans-serif`, color: color.ink, textAlign: 'center' }}>Parent settings</div>
          <div style={{ font: `${weight.semibold} 16px/1.4 Nunito, sans-serif`, color: ink(0.48), textAlign: 'center', marginTop: 6 }}>Enter your PIN</div>
          <PinPad onSubmit={handleSubmit} />
        </div>
        <button onClick={handleForgot} style={{ background: 'none', border: 'none', cursor: 'pointer', font: `${weight.bold} 15px/1 Nunito, sans-serif`, color: ink(0.4) }}>
          Forgot PIN?
        </button>
      </div>
    </PhoneFrame>
  );
}
