import { color, weight, font } from '../../theme/tokens.js';
import { cardBackground, formatTime } from '../../theme/scheduleLogic.js';

// One activity card (landscape/kiosk row layout — see ActivityStripCard.jsx
// for the portrait shape). Background follows the architecture doc's
// multi-participant rule: solid for 0-1 people, 2-color diagonal stripe for
// exactly 2, neutral + icon stack for 3+ (never striping 3+ colors).
//
// Sizing is fluid (clamp + cqw against TomorrowBoard.jsx's container), not
// a hardcoded compact/full boolean — see that file's own comment for why.
export default function ActivityCard({ event, members }) {
  const bg = cardBackground(event.memberIds, members);
  const time = formatTime(event.start);

  const style = { borderRadius: 'clamp(14px, 3cqw, 26px)', overflow: 'hidden', '--stripe': 'clamp(10px, 3cqw, 40px)' };
  if (bg.type === 'solid') style.background = bg.color;
  else if (bg.type === 'stripe') {
    style.background = `repeating-linear-gradient(135deg,${bg.colors[0]} 0 var(--stripe),${bg.colors[1]} var(--stripe) calc(var(--stripe) * 2))`;
  } else {
    style.background = color.neutralCard;
  }

  return (
    <div
      style={{
        ...style,
        padding: 'clamp(8px, 2cqw, 28px) clamp(4px, 1.5cqw, 18px) clamp(6px, 1.8cqw, 22px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'clamp(4px, 1.2cqw, 14px)',
        minHeight: 0,
        minWidth: 0,
        height: '100%',
      }}
    >
      {bg.type === 'neutral-stack' && (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: -6, '--stack-size': 'clamp(14px, 3.2cqw, 36px)' }}>
          {bg.memberIds.map((id, i) => {
            const m = members.find((mm) => mm.id === id);
            return (
              <div
                key={id}
                style={{
                  width: 'var(--stack-size)', height: 'var(--stack-size)', borderRadius: '50%', background: m?.calendar_color ?? color.neutralCard,
                  marginLeft: i === 0 ? 0 : 'calc(var(--stack-size) * -0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: `0 0 0 2px ${color.surface}`, fontSize: 'calc(var(--stack-size) * 0.55)',
                }}
              >
                {m?.kid_icon}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }} />
      <div style={{ font: `400 clamp(24px, 7cqw, 84px)/1 ${font.emoji}` }}>{event.icon}</div>
      <div style={{ flex: 1, minHeight: 0 }} />
      <div
        style={{
          font: `${weight.heavy} clamp(11px, 2.2cqw, 24px)/1.15 Nunito, sans-serif`, color: '#fff', textAlign: 'center',
          overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
        }}
      >
        {event.title}
      </div>
      {time && (
        <div style={{ font: `${weight.bold} clamp(9px, 1.6cqw, 17px)/1.3 Nunito, sans-serif`, color: 'rgba(255,255,255,.85)', textAlign: 'center', whiteSpace: 'nowrap' }}>
          {time}
        </div>
      )}
    </div>
  );
}
