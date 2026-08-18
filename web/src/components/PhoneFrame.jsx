import { color, ink, radius, shadow } from '../theme/tokens.js';

// The rounded 390x812 "phone" card every onboarding/settings screen sits in
// (matches the mocks). On desktop it's centered on the cream page background,
// same pattern the Settings Home mock uses for its web view.
//
// `onBack`, when given, renders a small low-visual-weight back arrow in the
// top-left corner — same treatment as the kid dashboard's settings gear.
// Settings screens pass this; onboarding's sequential flow deliberately
// doesn't (there's nothing to go "back" to mid-signup).
export default function PhoneFrame({ children, padding = '56px 28px 40px', onBack }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: color.page,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 16px',
      }}
    >
      <div
        style={{
          width: 390,
          height: 812,
          maxHeight: '92vh',
          boxSizing: 'border-box',
          background: color.surface,
          borderRadius: radius.card,
          border: `1px solid ${'rgba(0,0,0,.08)'}`,
          boxShadow: shadow.card,
          padding,
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          position: 'relative',
        }}
      >
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back"
            style={{
              position: 'absolute', top: 24, left: 24, width: 40, height: 40, borderRadius: '50%',
              background: 'rgba(58,49,40,.06)', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1,
            }}
          >
            <span className="ms" style={{ fontSize: 20, color: ink(0.4) }}>arrow_back</span>
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
