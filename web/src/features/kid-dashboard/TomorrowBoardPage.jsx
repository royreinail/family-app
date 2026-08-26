import { useEffect, useState } from 'react';
import { color, ink, weight } from '../../theme/tokens.js';
import { getTomorrow } from '../../api/client.js';
import TomorrowBoard from './TomorrowBoard.jsx';
import SettingsGear from './SettingsGear.jsx';

// The real, read-only kid dashboard page — no interactive elements beyond
// the settings gear (Phase 3 scopes tap-to-filter icons, deliberately not here).
export default function TomorrowBoardPage() {
  const [data, setData] = useState(null);
  // The shared request() helper throws on any non-2xx response, including
  // dashboard.js's deliberate 502 "calendar_unavailable" — without a catch
  // here, that left this screen stuck on the blank loading state forever
  // (no error, no retry, nothing) on a transient Calendar API hiccup. This
  // is the kid-facing screen the whole app exists for, so it gets its own
  // distinct "couldn't load" state rather than silently going quiet.
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    getTomorrow()
      .then(setData)
      .catch((err) => setLoadError(err.message));
  }, []);

  if (loadError) {
    return (
      <div style={{ minHeight: '100vh', background: color.page, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, position: 'relative' }}>
        <SettingsGear />
        <span className="ms" style={{ fontSize: 64, color: ink(0.3) }}>cloud_off</span>
        <div style={{ font: `${weight.heavy} 22px/1.3 Nunito, sans-serif`, color: color.ink }}>Couldn't load tomorrow's board</div>
        <div style={{ font: `${weight.semibold} 15px/1.4 Nunito, sans-serif`, color: ink(0.5) }}>Try again in a bit — nothing was lost.</div>
      </div>
    );
  }

  if (!data) {
    return <div style={{ minHeight: '100vh', background: color.page }} />;
  }

  if (!data.connected) {
    return (
      <div style={{ minHeight: '100vh', background: color.page, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, position: 'relative' }}>
        <SettingsGear />
        <span className="ms" style={{ fontSize: 64, color: ink(0.3) }}>calendar_today</span>
        <div style={{ font: `${weight.heavy} 22px/1.3 Nunito, sans-serif`, color: color.ink }}>Calendar not connected yet</div>
        <div style={{ font: `${weight.semibold} 15px/1.4 Nunito, sans-serif`, color: ink(0.5) }}>Finish onboarding to see tomorrow's board.</div>
      </div>
    );
  }

  return (
    // containerType: 'size' + a definite height (not just minHeight) is
    // what lets TomorrowBoard.jsx's cqw/cqh values react to the real
    // screen size here — see that file's own comment for the full picture.
    <div style={{ height: '100vh', background: color.page, containerType: 'size' }}>
      <TomorrowBoard members={data.members} events={data.events} showGear={<SettingsGear />} />
    </div>
  );
}
