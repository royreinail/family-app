import { color, ink, weight } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PinPad from '../../../components/PinPad.jsx';
import { setPin } from '../../../api/client.js';

export const STEP_INDEX = 5;

/** Reused in Settings Home > PIN & Security (editMode: change the PIN, no skip link). */
export default function PinStep({ totalSteps, onNext, editMode = false, onDone }) {
  async function handleSubmit(pin) {
    await setPin(pin);
    editMode ? onDone?.() : onNext();
    return true;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
      {!editMode && <ProgressDots total={totalSteps} current={STEP_INDEX} />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: -10 }}>
        <div style={{ width: 96, height: 96, borderRadius: '50%', background: color.accentSettingsTint, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
          <span className="ms" style={{ fontSize: 52, color: color.accentSettings }}>lock</span>
        </div>
        <div style={{ font: `${weight.heavy} 30px/1.2 Nunito, sans-serif`, color: color.ink, textAlign: 'center', letterSpacing: '-.4px' }}>
          {editMode ? 'Set a new PIN' : 'Set a parent PIN'}
        </div>
        <div style={{ font: `${weight.semibold} 17px/1.5 Nunito, sans-serif`, color: ink(0.52), textAlign: 'center', maxWidth: 280 }}>
          So the kids can look, but only a parent can change things.
        </div>
        <PinPad onSubmit={handleSubmit} />
      </div>
      {!editMode && (
        <button onClick={onNext} style={{ background: 'none', border: 'none', cursor: 'pointer', font: `${weight.bold} 15px/1 Nunito, sans-serif`, color: ink(0.42) }}>
          Skip — I'll set this up later
        </button>
      )}
    </div>
  );
}
