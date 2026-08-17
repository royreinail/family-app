import { color } from '../../theme/tokens.js';

// Wake-up / bedtime bookends — day boundaries, not activities, so they're
// plain flanking icons with no color band or title card (per the approved
// mock: the 4-5 item cap only ever applies to real activity cards).
export default function BookendIcon({ kind, compact = false }) {
  const icon = kind === 'wake' ? 'wb_sunny' : 'bedtime';
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <span className="ms" style={{ fontSize: compact ? 22 : 64, color: color.neutralIcon }}>{icon}</span>
    </div>
  );
}
