import { useNavigate } from 'react-router-dom';
import { ink } from '../../theme/tokens.js';

// Small, low-visual-weight gear — the board stays a read-only display for
// the kid; the gear is the parent's quiet way in. PIN-gating (not visual
// subtlety) is what actually protects it, per the kiosk-app precedent.
export default function SettingsGear() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate('/settings')}
      aria-label="Settings"
      style={{
        position: 'absolute', top: 24, right: 24, width: 44, height: 44, borderRadius: '50%',
        background: 'rgba(58,49,40,.06)', border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <span className="ms" style={{ fontSize: 22, color: ink(0.4) }}>settings</span>
    </button>
  );
}
