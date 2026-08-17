import { useState } from 'react';
import { color, ink, radius, weight } from '../theme/tokens.js';

// Numeric keypad + PIN dots, shared between onboarding step 6 (set a PIN)
// and the Settings Home PIN gate (verify a PIN). No error-shaming on a wrong
// entry — a gentle shake + clear only, per the Settings Home mock.
export default function PinPad({ onSubmit, length = 4 }) {
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);

  async function press(digit) {
    if (shake || busy) return;
    if (digit === 'back') {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (pin.length >= length) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === length) {
      setBusy(true);
      const ok = await onSubmit(next);
      setBusy(false);
      if (ok === false) {
        setShake(true);
        setTimeout(() => {
          setShake(false);
          setPin('');
        }, 450);
      }
    }
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
      <div className={shake ? 'shake' : ''} style={{ display: 'flex', gap: 18, margin: '34px 0 44px' }}>
        {Array.from({ length }, (_, i) => (
          <div
            key={i}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: pin.length > i ? color.accentSettings : ink(0.15),
            }}
          />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,78px)', gap: 22, justifyContent: 'center' }}>
        {keys.map((k, i) =>
          k === '' ? (
            <div key={i} style={{ width: 78, height: 78 }} />
          ) : k === 'back' ? (
            <button
              key={i}
              onClick={() => press('back')}
              style={{
                width: 78,
                height: 78,
                borderRadius: '50%',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span className="ms" style={{ fontSize: 28, color: ink(0.4) }}>
                backspace
              </span>
            </button>
          ) : (
            <button
              key={i}
              onClick={() => press(k)}
              style={{
                width: 78,
                height: 78,
                borderRadius: '50%',
                background: color.white,
                border: 'none',
                cursor: 'pointer',
                boxShadow: `0 2px 6px ${ink(0.07)}`,
                font: `${weight.heavy} 30px/1 Nunito, sans-serif`,
                color: color.ink,
              }}
            >
              {k}
            </button>
          )
        )}
      </div>
    </div>
  );
}
