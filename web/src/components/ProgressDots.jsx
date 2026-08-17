import { color, ink } from '../theme/tokens.js';

// Filled-to-current-step progress indicator used on every onboarding screen.
export default function ProgressDots({ total, current }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            width: i === current ? 26 : 8,
            height: 8,
            borderRadius: 4,
            background: i <= current ? color.personPurple : ink(0.15),
            transition: 'width 160ms ease',
          }}
        />
      ))}
    </div>
  );
}
