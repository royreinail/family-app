import { color, weight, font } from '../../theme/tokens.js';
import { cardBackground, formatTime } from '../../theme/scheduleLogic.js';

// Mobile-portrait card shape (approved mock: Tomorrow Board.dc.html, option
// 5b) — a full-width horizontal strip (icon left, title+time right), one per
// row, instead of ActivityCard's tall centered tile. Same background rule
// (cardBackground) and same event/members data, just laid out differently —
// TomorrowBoard.jsx renders both this and ActivityCard side by side and lets
// a CSS orientation media query pick which one shows (see globals.css).
//
// Sizing is fluid (clamp + cqw against TomorrowBoard.jsx's container), not
// a hardcoded compact/full boolean — see that file's own comment for why.
export default function ActivityStripCard({ event, members }) {
  const bg = cardBackground(event.memberIds, members);
  const time = formatTime(event.start);

  const style = { borderRadius: 'clamp(14px, 3cqw, 26px)', overflow: 'hidden', '--stripe': 'clamp(10px, 2cqw, 26px)' };
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
        height: '100%',
        boxSizing: 'border-box',
        padding: '0 clamp(10px, 2.2cqw, 18px)',
        display: 'flex',
        alignItems: 'center',
        gap: 'clamp(8px, 2cqw, 16px)',
        minWidth: 0,
      }}
    >
      <div style={{ font: `400 clamp(20px, 4.5cqw, 40px)/1 ${font.emoji}`, flex: 'none' }}>{event.icon}</div>

      {bg.type === 'neutral-stack' && (
        <div style={{ display: 'flex', alignItems: 'center', flex: 'none', '--stack-size': 'clamp(14px, 2.8cqw, 26px)' }}>
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

      <div style={{ flex: 1, minWidth: 0 }} />

      <div style={{ textAlign: 'right', minWidth: 0 }}>
        <div
          style={{
            font: `${weight.heavy} clamp(13px, 2cqw, 18px)/1.15 Nunito, sans-serif`, color: '#fff',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {event.title}
        </div>
        {time && (
          <div style={{ font: `${weight.bold} clamp(10px, 1.4cqw, 13px)/1.3 Nunito, sans-serif`, color: 'rgba(255,255,255,.85)', whiteSpace: 'nowrap' }}>
            {time}
          </div>
        )}
      </div>
    </div>
  );
}
