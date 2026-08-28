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
          // Explicit responsive cap (min() of the 390px design width and
          // whatever room is actually available) rather than a bare fixed
          // 390 relying on this being a flex child that happens to shrink —
          // works out the same on every browser tested here, but makes the
          // real intent (cap at 390, shrink to fit below that) the actual
          // rule instead of an implicit flexbox side effect.
          width: 'min(390px, 100%)',
          height: 812,
          maxHeight: '92vh',
          boxSizing: 'border-box',
          background: color.surface,
          borderRadius: radius.card,
          border: `1px solid ${'rgba(0,0,0,.08)'}`,
          boxShadow: shadow.card,
          padding,
          // Keep the gap above the button tight (matches the original
          // absolute-positioned look) independent of whatever top padding
          // a given screen asks for — the button's own marginBottom below
          // is what creates the gap to the content, not this. Only included
          // when onBack is set: a style object key present with an
          // undefined value still clears that longhand in React (it does
          // NOT just leave whatever the `padding` shorthand above set) —
          // omitting the key entirely is what actually leaves it alone.
          // This wiped out top padding on every onBack-less screen
          // (all of onboarding) until caught in real testing.
          ...(onBack ? { paddingTop: 24 } : {}),
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
        }}
      >
        {onBack && (
          // A normal flex child (not absolutely positioned over the content)
          // so it reliably pushes whatever the screen renders below it down
          // by a real gap, instead of the two visually crowding each other.
          <button
            onClick={onBack}
            aria-label="Back"
            style={{
              flex: 'none', width: 40, height: 40, borderRadius: '50%', marginBottom: 28,
              background: 'rgba(58,49,40,.06)', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
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
