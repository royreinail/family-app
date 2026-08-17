import { color, ink, weight, radius } from '../../theme/tokens.js';
import PhoneFrame from '../../components/PhoneFrame.jsx';
import { logout } from '../../api/client.js';
import { useNavigate } from 'react-router-dom';

const ROWS = [
  { key: 'family-members', label: 'Family Members', icon: 'groups', tint: color.accentSettingsTint, fg: color.accentSettings },
  { key: 'timezone', label: 'Timezone', icon: 'schedule', tint: color.accentTimezoneTint, fg: color.accentTimezone },
  { key: 'whatsapp', label: 'WhatsApp Connection', icon: 'chat', tint: color.accentWhatsappTint, fg: color.accentWhatsapp },
  { key: 'pin', label: 'PIN & Security', icon: 'password', tint: color.accentSettingsTint, fg: color.accentSettings },
];

// The Settings Home menu — a menu, not a form. Tapping a row jumps directly
// into that single onboarding-step component in edit mode and returns here
// when done (see SettingsPage.jsx for the view-switching controller).
export default function SettingsHome({ onSelect }) {
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/');
  }

  return (
    <PhoneFrame padding="64px 22px 40px">
      <div style={{ padding: '0 6px 26px' }}>
        <div style={{ font: `${weight.heavy} 30px/1.2 Nunito, sans-serif`, color: color.ink, letterSpacing: '-.4px' }}>Settings</div>
        <div style={{ font: `${weight.semibold} 16px/1.4 Nunito, sans-serif`, color: ink(0.48), marginTop: 4 }}>Manage the family board</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {ROWS.map((row) => (
          <button
            key={row.key}
            onClick={() => onSelect(row.key)}
            style={{
              background: color.white, borderRadius: radius.lg, padding: 18, display: 'flex', alignItems: 'center', gap: 16,
              boxShadow: `0 2px 6px ${ink(0.06)}`, border: 'none', cursor: 'pointer', textAlign: 'left',
            }}
          >
            <div style={{ width: 56, height: 56, borderRadius: 16, background: row.tint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <span className="ms" style={{ fontSize: 30, color: row.fg }}>{row.icon}</span>
            </div>
            <div style={{ font: `${weight.heavy} 20px/1.2 Nunito, sans-serif`, color: color.ink, flex: 1 }}>{row.label}</div>
            <span className="ms" style={{ fontSize: 26, color: ink(0.25) }}>chevron_right</span>
          </button>
        ))}

        <div style={{ flex: 1 }} />

        <button
          onClick={handleLogout}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: radius.lg, padding: 18, display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left' }}
        >
          <div style={{ width: 56, height: 56, borderRadius: 16, background: ink(0.06), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <span className="ms" style={{ fontSize: 30, color: ink(0.45) }}>logout</span>
          </div>
          <div style={{ font: `${weight.heavy} 20px/1.2 Nunito, sans-serif`, color: ink(0.6), flex: 1 }}>Log Out</div>
        </button>
      </div>
    </PhoneFrame>
  );
}
