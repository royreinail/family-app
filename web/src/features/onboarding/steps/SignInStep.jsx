import { color, ink, weight } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import { signInWithGoogleUrl } from '../../../api/client.js';
import { useFamily } from '../../../context/FamilyContext.jsx';

export const STEP_INDEX = 0;

// Dev-only visual QA affordance — calls the fake-signin route added by
// server/scripts/devPreview.js (never mounted by src/app.js). Stripped from
// production builds: import.meta.env.DEV is statically false under `vite build`.
async function devFakeSignIn(refresh, onNext) {
  await fetch('/dev/fake-signin', { method: 'POST', credentials: 'include' });
  await refresh();
  onNext();
}

export default function SignInStep({ totalSteps, onNext }) {
  const { refresh } = useFamily();
  return (
    <>
      <ProgressDots total={totalSteps} current={STEP_INDEX} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, marginTop: -40 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ width: 58, height: 58, borderRadius: 20, background: color.personPurple, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'rotate(-8deg)' }}>
            <span className="ms" style={{ fontSize: 34, color: '#fff' }}>wb_sunny</span>
          </div>
          <div style={{ width: 66, height: 66, borderRadius: 22, background: color.personApricot, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 -8px', zIndex: 1 }}>
            <span className="ms" style={{ fontSize: 40, color: '#fff' }}>calendar_today</span>
          </div>
          <div style={{ width: 58, height: 58, borderRadius: 20, background: color.night, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'rotate(8deg)' }}>
            <span className="ms" style={{ fontSize: 34, color: color.nightIcon }}>bedtime</span>
          </div>
        </div>
        <div style={{ font: `${weight.heavy} 38px/1.15 Nunito, sans-serif`, color: color.ink, textAlign: 'center', letterSpacing: '-.5px' }}>
          Tomorrow,<br />on the fridge
        </div>
        <div style={{ font: `${weight.semibold} 19px/1.5 Nunito, sans-serif`, color: ink(0.5), textAlign: 'center', maxWidth: 280 }}>
          A calm daily view your kids can read before they can read.
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center' }}>
        <a
          href={signInWithGoogleUrl()}
          style={{
            width: '100%', height: 64, borderRadius: 32, background: color.white,
            border: `1.5px solid ${ink(0.14)}`, boxShadow: `0 2px 6px ${ink(0.07)}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
            textDecoration: 'none', boxSizing: 'border-box',
          }}
        >
          <svg width="24" height="24" viewBox="0 0 48 48">
            <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.3h12.1c-.2 2-1.6 5-4.5 7l-.1.4 6.5 5 .5.1c4.2-3.8 6.6-9.5 6.6-15.8" />
            <path fill="#34A853" d="M24 46c5.9 0 10.9-1.9 14.5-5.3l-6.9-5.3c-1.8 1.3-4.3 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-.4.1-6.7 5.2-.1.4C7.9 41 15.3 46 24 46" />
            <path fill="#FBBC05" d="M11.5 28.5c-.5-1.4-.7-2.9-.7-4.5s.3-3.1.7-4.5v-.5l-6.8-5.3-.2.1C2.9 16.9 2 20.3 2 24s.9 7.1 2.5 10.2z" />
            <path fill="#EB4335" d="M24 10.4c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.1 29.9 2 24 2 15.3 2 7.9 7 4.5 13.8l6.9 5.3c1.9-5.3 6.8-8.7 12.6-8.7" />
          </svg>
          <span style={{ font: `${weight.heavy} 20px/1 Nunito, sans-serif`, color: color.ink }}>Continue with Google</span>
        </a>
        <div style={{ font: `${weight.semibold} 13.5px/1.5 Nunito, sans-serif`, color: ink(0.38), textAlign: 'center', maxWidth: 290 }}>
          We only read your calendar. Nothing is ever posted or shared.
        </div>
        {import.meta.env.DEV && (
          <button
            onClick={() => devFakeSignIn(refresh, onNext)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', font: `${weight.bold} 12px/1 Nunito, sans-serif`, color: ink(0.3) }}
          >
            (dev preview: skip Google sign-in)
          </button>
        )}
      </div>
    </>
  );
}
