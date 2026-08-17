import { color, ink, radius, weight, shadow } from '../theme/tokens.js';

// The one 64px pill button used for every primary action across onboarding
// and settings (design note from the mocks: "one button per screen").
export default function PrimaryButton({ children, onClick, tone = 'purple', disabled, type = 'button' }) {
  const tones = {
    purple: { bg: color.personPurple, rgb: '107,88,166' },
    green: { bg: color.accentWhatsapp, rgb: '37,150,63' },
  };
  const t = tones[tone] ?? tones.purple;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        height: 64,
        borderRadius: radius.pill,
        background: disabled ? ink(0.15) : t.bg,
        border: 'none',
        boxShadow: disabled ? 'none' : shadow.buttonTint(t.rgb),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ font: `${weight.heavy} 20px/1 ${'Nunito, sans-serif'}`, color: '#fff' }}>{children}</span>
    </button>
  );
}
