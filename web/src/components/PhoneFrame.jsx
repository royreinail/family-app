import { color, radius, shadow } from '../theme/tokens.js';

// The rounded 390x812 "phone" card every onboarding/settings screen sits in
// (matches the mocks). On desktop it's centered on the cream page background,
// same pattern the Settings Home mock uses for its web view.
export default function PhoneFrame({ children, padding = '56px 28px 40px' }) {
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
        }}
      >
        {children}
      </div>
    </div>
  );
}
