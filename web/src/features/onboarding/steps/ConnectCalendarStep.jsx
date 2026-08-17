import { color, ink, weight } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PrimaryButton from '../../../components/PrimaryButton.jsx';
import { signInWithGoogleUrl } from '../../../api/client.js';
import { useFamily } from '../../../context/FamilyContext.jsx';

export const STEP_INDEX = 1;

// See SignInStep.jsx for why this dev-only shortcut is safe to ship —
// stripped from production builds by import.meta.env.DEV.
async function devFakeConnect(refresh, onNext) {
  await fetch('/dev/fake-calendar-connect', { method: 'POST', credentials: 'include' });
  await refresh();
  onNext();
}

export default function ConnectCalendarStep({ totalSteps, session, onNext }) {
  const { refresh } = useFamily();
  const connected = session?.calendarConnected;
  return (
    <>
      <ProgressDots total={totalSteps} current={STEP_INDEX} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 28, marginTop: -30 }}>
        <div style={{ alignSelf: 'center', width: 132, height: 132, borderRadius: 40, background: color.accentCalendarTint, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="ms" style={{ fontSize: 82, color: color.accentCalendar }}>event_available</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ font: `${weight.heavy} 32px/1.2 Nunito, sans-serif`, color: color.ink, textAlign: 'center', letterSpacing: '-.4px' }}>
            Bring your calendar in
          </div>
          <div style={{ font: `${weight.semibold} 18px/1.55 Nunito, sans-serif`, color: ink(0.52), textAlign: 'center' }}>
            Events sync automatically, so tomorrow's board is always right without anyone typing it in.
          </div>
        </div>
        {connected && (
          <div style={{ background: color.white, borderRadius: 22, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14, boxShadow: `0 2px 6px ${ink(0.06)}` }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: color.page, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <span className="ms" style={{ fontSize: 26, color: ink(0.55) }}>account_circle</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: `${weight.heavy} 16px/1.2 Nunito, sans-serif`, color: color.ink }}>{session.family?.name ?? 'Connected'}</div>
              <div style={{ font: `${weight.semibold} 14px/1.3 Nunito, sans-serif`, color: ink(0.45), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {session.googleAccountEmail}
              </div>
            </div>
            <span className="ms" style={{ fontSize: 26, color: color.personSage }}>check_circle</span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        {connected ? (
          <PrimaryButton onClick={onNext}>Continue</PrimaryButton>
        ) : (
          <a href={signInWithGoogleUrl()} style={{ width: '100%', textDecoration: 'none' }}>
            <PrimaryButton onClick={() => {}}>Connect calendar</PrimaryButton>
          </a>
        )}
        {!connected && import.meta.env.DEV && (
          <button
            onClick={() => devFakeConnect(refresh, onNext)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', font: `${weight.bold} 12px/1 Nunito, sans-serif`, color: ink(0.3) }}
          >
            (dev preview: skip Google OAuth)
          </button>
        )}
      </div>
    </>
  );
}
