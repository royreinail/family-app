import { useEffect, useState } from 'react';
import { color, ink, weight } from '../../theme/tokens.js';
import { getTomorrow } from '../../api/client.js';
import TomorrowBoard from './TomorrowBoard.jsx';
import SettingsGear from './SettingsGear.jsx';

// The real, read-only kid dashboard page — no interactive elements beyond
// the settings gear (Phase 3 scopes tap-to-filter icons, deliberately not here).
export default function TomorrowBoardPage() {
  const [data, setData] = useState(null);

  useEffect(() => {
    getTomorrow().then(setData);
  }, []);

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
    <div style={{ minHeight: '100vh', background: color.page }}>
      <TomorrowBoard members={data.members} events={data.events} showGear={<SettingsGear />} />
    </div>
  );
}
