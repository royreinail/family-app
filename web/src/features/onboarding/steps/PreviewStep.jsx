import { useEffect, useState } from 'react';
import { color, ink, weight } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PrimaryButton from '../../../components/PrimaryButton.jsx';
import TomorrowBoard from '../../kid-dashboard/TomorrowBoard.jsx';
import { getFamilyMembers } from '../../../api/client.js';

export const STEP_INDEX = 6;

// Sample activities so the parent sees the real payoff (their own colors,
// icons, names) before anything has actually been captured yet — the
// architecture doc's rationale: "so the parent sees the payoff before
// finishing rather than trusting it blindly."
function sampleEvents(members) {
  const ids = members.map((m) => m.id);
  const pick = (i) => (ids[i % Math.max(ids.length, 1)] ? [ids[i % ids.length]] : []);
  return [
    { id: 's1', title: 'School', icon: '🎒', start: '08:00', memberIds: pick(0) },
    { id: 's2', title: 'Doctor', icon: '🩺', start: '15:30', memberIds: pick(1) },
    { id: 's3', title: 'Dance', icon: '💃', start: '16:00', memberIds: pick(0) },
    { id: 's4', title: 'Playdate', icon: '⚽', start: '17:30', memberIds: pick(2) },
  ];
}

export default function PreviewStep({ totalSteps, onFinish }) {
  const [members, setMembers] = useState([]);

  useEffect(() => {
    getFamilyMembers().then(({ members }) => setMembers(members));
  }, []);

  return (
    <>
      <ProgressDots total={totalSteps} current={STEP_INDEX} />
      <div style={{ padding: '24px 4px 16px', textAlign: 'center' }}>
        <div style={{ font: `${weight.heavy} 30px/1.2 Nunito, sans-serif`, color: color.ink, letterSpacing: '-.4px' }}>Here's tomorrow</div>
        <div style={{ font: `${weight.semibold} 17px/1.45 Nunito, sans-serif`, color: ink(0.48), marginTop: 6 }}>This is what the kids will see.</div>
      </div>
      <div style={{ flex: 1, background: color.page, borderRadius: 26, boxShadow: `inset 0 2px 6px ${ink(0.06)}`, overflow: 'hidden' }}>
        <TomorrowBoard members={members} events={sampleEvents(members)} compact />
      </div>
      <div style={{ marginTop: 16 }}>
        <PrimaryButton onClick={onFinish}>Finish setup</PrimaryButton>
      </div>
    </>
  );
}
