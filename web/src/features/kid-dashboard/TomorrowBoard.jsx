import { color, ink, weight, KID_DASHBOARD_ITEM_CAP } from '../../theme/tokens.js';
import { capItems } from '../../theme/scheduleLogic.js';
import ActivityCard from './ActivityCard.jsx';
import ActivityStripCard from './ActivityStripCard.jsx';
import BookendIcon from './BookendIcon.jsx';

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date(Date.now() + 86400000));

/**
 * Pure presentational board — takes members + events as props so it can be
 * driven by real data (kid dashboard) or sample data (onboarding preview,
 * see features/onboarding/steps/PreviewStep.jsx) through the exact same
 * rendering + capping logic (frontend guardrail 1), not a lookalike copy.
 *
 * Sizing is fluid via CSS container queries (cqw), clamped to sane min/max
 * bounds — not a hardcoded compact/full boolean. The board reacts to
 * whatever box it's actually rendered into (a real phone, a kiosk tablet,
 * or the small onboarding-preview box) automatically, the same way the
 * approved mock (Tomorrow Board.dc.html) specifies: "sizing uses container
 * queries so every element scales with the box itself, not just the page."
 * The one thing that still switches structurally rather than scaling is
 * the row-vs-stack arrangement below, which stays orientation-driven
 * (globals.css's .tb-row-layout/.tb-stack-layout) — that's a genuine shape
 * change, not a size one. Requires the caller's own container to have
 * `containerType: 'size'` and a definite height (see TomorrowBoardPage.jsx
 * and PreviewStep.jsx).
 */
export default function TomorrowBoard({ members, events, showGear }) {
  const cards = capItems(events, KID_DASHBOARD_ITEM_CAP);

  return (
    <div
      style={{
        position: 'relative', background: color.page, borderRadius: 0,
        padding: 'clamp(14px, 4cqw, 40px) clamp(14px, 5cqw, 48px)', display: 'flex', flexDirection: 'column',
        gap: 'clamp(8px, 2.4cqw, 24px)', height: '100%', boxSizing: 'border-box',
      }}
    >
      {showGear}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(6px, 1.8cqw, 20px)', paddingRight: showGear ? 60 : 0 }}>
        <span className="ms" style={{ fontSize: 'clamp(24px, 4.5cqw, 52px)', color: color.sun }}>wb_twilight</span>
        <div style={{ font: `${weight.heavy} clamp(18px, 3.8cqw, 42px)/1 Nunito, sans-serif`, color: color.ink, letterSpacing: '-.4px' }}>Tomorrow</div>
        <div style={{ font: `${weight.semibold} clamp(12px, 1.9cqw, 22px)/1 Nunito, sans-serif`, color: ink(0.42) }}>{WEEKDAY}</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 'clamp(4px, 1cqw, 12px)' }}>
          {members.map((m) => (
            <div
              key={m.id}
              title={m.name}
              style={{
                '--avatar-size': 'clamp(26px, 6.5cqw, 84px)',
                width: 'var(--avatar-size)', height: 'var(--avatar-size)', borderRadius: '50%', background: m.calendar_color,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(var(--avatar-size) * 0.5)',
              }}
            >
              {m.kid_icon}
            </div>
          ))}
        </div>
      </div>

      {/*
        Two card layouts, both rendered, CSS orientation media query picks
        which one shows (globals.css) — not a JS resize listener, so there's
        no flicker/mismatch and it responds immediately on device rotation.
        Landscape (desktop/kiosk/mobile-landscape): horizontal row of tall
        tile-cards, unchanged from before. Portrait (real phone, held
        normally): vertical stack of horizontal strip-cards — approved mock
        split 5a/5c vs 5b in Tomorrow Board.dc.html.
      */}
      <div className="tb-row-layout" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `repeat(${cards.length + 2},1fr)`, gap: 'clamp(6px, 1.8cqw, 18px)' }}>
        <BookendIcon kind="wake" />
        {cards.map((event) => (
          <ActivityCard key={event.id} event={event} members={members} />
        ))}
        <BookendIcon kind="sleep" />
      </div>

      <div className="tb-stack-layout" style={{ flex: 1, minHeight: 0, flexDirection: 'column', gap: 'clamp(6px, 1.5cqh, 12px)' }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <BookendIcon kind="wake" />
        </div>
        {cards.map((event) => (
          <div key={event.id} style={{ flex: 1, minHeight: 0 }}>
            <ActivityStripCard event={event} members={members} />
          </div>
        ))}
        <div style={{ flex: 1, minHeight: 0 }}>
          <BookendIcon kind="sleep" />
        </div>
      </div>
    </div>
  );
}
