import { color, weight, radius, font } from '../../theme/tokens.js';
import { cardBackground, formatTime } from '../../theme/scheduleLogic.js';

// Mobile-portrait card shape (approved mock: Tomorrow Board.dc.html, option
// 5b) — a full-width horizontal strip (icon left, title+time right), one per
// row, instead of ActivityCard's tall centered tile. Same background rule
// (cardBackground) and same event/members data, just laid out differently —
// TomorrowBoard.jsx renders both this and ActivityCard side by side and lets
// a CSS orientation media query pick which one shows (see globals.css).
export default function ActivityStripCard({ event, members, compact = false }) {
  const bg = cardBackground(event.memberIds, members);
  const time = formatTime(event.start);

  const style = { borderRadius: compact ? radius.md : radius.xl, overflow: 'hidden' };
  if (bg.type === 'solid') style.background = bg.color;
  else if (bg.type === 'stripe') {
    const stripe = compact ? 12 : 26;
    style.background = `repeating-linear-gradient(135deg,${bg.colors[0]} 0 ${stripe}px,${bg.colors[1]} ${stripe}px ${stripe * 2}px)`;
  } else {
    style.background = color.neutralCard;
  }

  const emojiSize = compact ? 20 : 40;
  const titleSize = compact ? 13 : 18;
  const timeSize = compact ? 10 : 13;
  const stackSize = compact ? 14 : 26;

  return (
    <div
      style={{
        ...style,
        height: '100%',
        boxSizing: 'border-box',
        padding: compact ? '0 10px' : '0 18px',
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 8 : 16,
        minWidth: 0,
      }}
    >
      <div style={{ font: `400 ${emojiSize}px/1 ${font.emoji}`, flex: 'none' }}>{event.icon}</div>

      {bg.type === 'neutral-stack' && (
        <div style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
          {bg.memberIds.map((id, i) => {
            const m = members.find((mm) => mm.id === id);
            return (
              <div
                key={id}
                style={{
                  width: stackSize, height: stackSize, borderRadius: '50%', background: m?.calendar_color ?? color.neutralCard,
                  marginLeft: i === 0 ? 0 : -stackSize * 0.35, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: `0 0 0 2px ${color.surface}`, fontSize: stackSize * 0.55,
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
            font: `${weight.heavy} ${titleSize}px/1.15 Nunito, sans-serif`, color: '#fff',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {event.title}
        </div>
        {time && (
          <div style={{ font: `${weight.bold} ${timeSize}px/1.3 Nunito, sans-serif`, color: 'rgba(255,255,255,.85)', whiteSpace: 'nowrap' }}>
            {time}
          </div>
        )}
      </div>
    </div>
  );
}
