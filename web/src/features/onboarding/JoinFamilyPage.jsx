import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import PhoneFrame from '../../components/PhoneFrame.jsx';
import { color, ink, weight } from '../../theme/tokens.js';
import { previewInvite, signInWithGoogleUrl } from '../../api/client.js';

// Backlog 1.3 — landing page for an invite link (/join/:code). Shown before
// sign-in on purpose, so whoever clicks it knows what/who they're about to
// join before Google's consent screen. The actual joining happens in
// auth.js's callback once they sign in — this page just previews + hands
// off to the same OAuth flow with the code attached.
export default function JoinFamilyPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, familyName: null, error: null });

  useEffect(() => {
    previewInvite(code)
      .then(({ familyName }) => setState({ loading: false, familyName, error: null }))
      .catch((err) => setState({ loading: false, familyName: null, error: err.message }));
  }, [code]);

  return (
    <PhoneFrame onBack={() => navigate('/')}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 26 }}>
        <div style={{ width: 96, height: 96, borderRadius: '50%', background: color.accentSettingsTint, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="ms" style={{ fontSize: 52, color: color.accentSettings }}>group_add</span>
        </div>

        {state.loading && (
          <div style={{ font: `${weight.semibold} 17px/1.5 Nunito, sans-serif`, color: ink(0.48), textAlign: 'center' }}>Checking your invite…</div>
        )}

        {!state.loading && state.error && (
          <>
            <div style={{ font: `${weight.heavy} 26px/1.2 Nunito, sans-serif`, color: color.ink, textAlign: 'center' }}>
              This invite isn't valid
            </div>
            <div style={{ font: `${weight.semibold} 16px/1.5 Nunito, sans-serif`, color: ink(0.48), textAlign: 'center', maxWidth: 280 }}>
              Ask the person who sent it for a fresh link — invite codes stay the same, so a re-sent one will work.
            </div>
          </>
        )}

        {!state.loading && !state.error && (
          <>
            <div style={{ font: `${weight.heavy} 28px/1.2 Nunito, sans-serif`, color: color.ink, textAlign: 'center', letterSpacing: '-.4px' }}>
              Join {state.familyName}
            </div>
            <div style={{ font: `${weight.semibold} 17px/1.5 Nunito, sans-serif`, color: ink(0.52), textAlign: 'center', maxWidth: 280 }}>
              Same calendar, same kids, same bot. Sign in with Google to join.
            </div>
            <a
              href={signInWithGoogleUrl(code)}
              style={{
                width: '100%', maxWidth: 300, height: 60, borderRadius: 30, background: color.white,
                border: `1.5px solid ${ink(0.14)}`, boxShadow: `0 2px 6px ${ink(0.07)}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
                textDecoration: 'none', boxSizing: 'border-box',
              }}
            >
              <svg width="22" height="22" viewBox="0 0 48 48">
                <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.3h12.1c-.2 2-1.6 5-4.5 7l-.1.4 6.5 5 .5.1c4.2-3.8 6.6-9.5 6.6-15.8" />
                <path fill="#34A853" d="M24 46c5.9 0 10.9-1.9 14.5-5.3l-6.9-5.3c-1.8 1.3-4.3 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-.4.1-6.7 5.2-.1.4C7.9 41 15.3 46 24 46" />
                <path fill="#FBBC05" d="M11.5 28.5c-.5-1.4-.7-2.9-.7-4.5s.3-3.1.7-4.5v-.5l-6.8-5.3-.2.1C2.9 16.9 2 20.3 2 24s.9 7.1 2.5 10.2z" />
                <path fill="#EB4335" d="M24 10.4c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.1 29.9 2 24 2 15.3 2 7.9 7 4.5 13.8l6.9 5.3c1.9-5.3 6.8-8.7 12.6-8.7" />
              </svg>
              <span style={{ font: `${weight.heavy} 18px/1 Nunito, sans-serif`, color: color.ink }}>Continue with Google</span>
            </a>
          </>
        )}
      </div>
    </PhoneFrame>
  );
}
