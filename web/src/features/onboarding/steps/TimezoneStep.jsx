import { useEffect, useState } from 'react';
import { color, ink, weight } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PrimaryButton from '../../../components/PrimaryButton.jsx';
import { setTimezone } from '../../../api/client.js';

export const STEP_INDEX = 3;

const COMMON_ZONES = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];

function currentTimeIn(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date());
  } catch {
    return '';
  }
}

/** Reused in Settings Home > Timezone (edit mode). */
export default function TimezoneStep({ totalSteps, onNext, editMode = false, onDone, initialTimezone }) {
  const detected = initialTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [tz, setTz] = useState(detected);
  const [picking, setPicking] = useState(false);

  async function confirm() {
    await setTimezone(tz);
    editMode ? onDone?.() : onNext();
  }

  return (
    <>
      {!editMode && <ProgressDots total={totalSteps} current={STEP_INDEX} />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 26, marginTop: -30 }}>
        <div style={{ alignSelf: 'center', width: 120, height: 120, borderRadius: '50%', background: color.accentTimezoneTint, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="ms" style={{ fontSize: 72, color: color.accentTimezone }}>schedule</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ font: `${weight.heavy} 32px/1.2 Nunito, sans-serif`, color: color.ink, textAlign: 'center', letterSpacing: '-.4px' }}>Is this your time?</div>
          <div style={{ font: `${weight.semibold} 18px/1.5 Nunito, sans-serif`, color: ink(0.52), textAlign: 'center' }}>So "tomorrow" starts when your day does.</div>
        </div>

        {picking ? (
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            style={{ font: `${weight.bold} 16px/1.3 Nunito, sans-serif`, padding: 14, borderRadius: 16, border: `1px solid ${ink(0.15)}` }}
          >
            {COMMON_ZONES.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        ) : (
          <div style={{ background: color.white, borderRadius: 24, padding: 22, boxShadow: `0 2px 8px ${ink(0.07)}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ font: `${weight.heavy} 26px/1.2 Nunito, sans-serif`, color: color.ink }}>{tz.replace(/_/g, ' ')}</div>
            <div style={{ font: `${weight.semibold} 17px/1.3 Nunito, sans-serif`, color: ink(0.45) }}>{currentTimeIn(tz)} right now</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, background: '#eef4ec', borderRadius: 20, padding: '6px 12px' }}>
              <span className="ms" style={{ fontSize: 18, color: color.personSage }}>my_location</span>
              <span style={{ font: `${weight.bold} 13.5px/1 Nunito, sans-serif`, color: '#5f7f56' }}>Detected from your device</span>
            </div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        <PrimaryButton onClick={confirm}>{editMode ? 'Save' : "Yes, that's right"}</PrimaryButton>
        {!picking && (
          <button
            onClick={() => setPicking(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', font: `${weight.bold} 15px/1 Nunito, sans-serif`, color: ink(0.42) }}
          >
            Choose a different timezone
          </button>
        )}
      </div>
    </>
  );
}
