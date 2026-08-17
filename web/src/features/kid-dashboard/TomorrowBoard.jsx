import { color, ink, weight, KID_DASHBOARD_ITEM_CAP } from '../../theme/tokens.js';
import { capItems } from '../../theme/scheduleLogic.js';
import ActivityCard from './ActivityCard.jsx';
import BookendIcon from './BookendIcon.jsx';

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date(Date.now() + 86400000));

/**
 * Pure presentational board — takes members + events as props so it can be
 * driven by real data (kid dashboard) or sample data (onboarding preview,
 * see features/onboarding/steps/PreviewStep.jsx) through the exact same
 * rendering + capping logic (frontend guardrail 1), not a lookalike copy.
 */
export default function TomorrowBoard({ members, events, showGear, compact = false }) {
  const cards = capItems(events, KID_DASHBOARD_ITEM_CAP);
  const avatarSize = compact ? 26 : 84;

  return (
    <div
      style={{
        position: 'relative', background: color.page, borderRadius: compact ? 18 : 0,
        padding: compact ? 14 : '40px 48px', display: 'flex', flexDirection: 'column',
        gap: compact ? 10 : 24, height: '100%', boxSizing: 'border-box',
      }}
    >
      {showGear}
      <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 9 : 20, paddingRight: showGear ? 60 : 0 }}>
        <span className="ms" style={{ fontSize: compact ? 26 : 52, color: color.sun }}>wb_twilight</span>
        <div style={{ font: `${weight.heavy} ${compact ? 20 : 42}px/1 Nunito, sans-serif`, color: color.ink, letterSpacing: '-.4px' }}>Tomorrow</div>
        <div style={{ font: `${weight.semibold} ${compact ? 14 : 22}px/1 Nunito, sans-serif`, color: ink(0.42) }}>{WEEKDAY}</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: compact ? 5 : 12 }}>
          {members.map((m) => (
            <div
              key={m.id}
              title={m.name}
              style={{
                width: avatarSize, height: avatarSize, borderRadius: '50%', background: m.calendar_color,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: avatarSize * 0.5,
              }}
            >
              {m.kid_icon}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `repeat(${cards.length + 2},1fr)`, gap: compact ? 6 : 18 }}>
        <BookendIcon kind="wake" compact={compact} />
        {cards.map((event) => (
          <ActivityCard key={event.id} event={event} members={members} compact={compact} />
        ))}
        <BookendIcon kind="sleep" compact={compact} />
      </div>
    </div>
  );
}
