import { color, weight, radius, font } from '../../theme/tokens.js';
import { cardBackground, formatTime } from '../../theme/scheduleLogic.js';

// One activity card. Background follows the architecture doc's
// multi-participant rule: solid for 0-1 people, 2-color diagonal stripe for
// exactly 2, neutral + icon stack for 3+ (never striping 3+ colors).
export default function ActivityCard({ event, members, compact = false }) {
  const bg = cardBackground(event.memberIds, members);
  const time = formatTime(event.start);

  const style = { borderRadius: compact ? radius.md : radius.xl, overflow: 'hidden' };
  if (bg.type === 'solid') style.background = bg.color;
  else if (bg.type === 'stripe') {
    const stripe = compact ? 14 : 40;
    style.background = `repeating-linear-gradient(135deg,${bg.colors[0]} 0 ${stripe}px,${bg.colors[1]} ${stripe}px ${stripe * 2}px)`;
  } else {
    style.background = color.neutralCard;
  }

  const emojiSize = compact ? 26 : 84;
  const titleSize = compact ? 12 : 24;
  const timeSize = compact ? 10 : 17;
  const stackSize = compact ? 16 : 36;

  return (
    <div
      style={{
        ...style,
        padding: compact ? '8px 4px 6px' : '28px 18px 22px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: compact ? 4 : 14,
        minHeight: 0,
        minWidth: 0,
        height: '100%',
      }}
    >
      {bg.type === 'neutral-stack' && (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: -6 }}>
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
      <div style={{ flex: 1, minHeight: 0 }} />
      <div style={{ font: `400 ${emojiSize}px/1 ${font.emoji}` }}>{event.icon}</div>
      <div style={{ flex: 1, minHeight: 0 }} />
      <div
        style={{
          font: `${weight.heavy} ${titleSize}px/1.15 Nunito, sans-serif`, color: '#fff', textAlign: 'center',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: compact ? 'nowrap' : 'normal', maxWidth: '100%',
        }}
      >
        {event.title}
      </div>
      {time && (
        <div style={{ font: `${weight.bold} ${timeSize}px/1.3 Nunito, sans-serif`, color: 'rgba(255,255,255,.85)', textAlign: 'center', whiteSpace: 'nowrap' }}>
          {time}
        </div>
      )}
    </div>
  );
}
