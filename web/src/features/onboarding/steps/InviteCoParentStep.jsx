import { useEffect, useState } from 'react';
import { color, ink, weight } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PrimaryButton from '../../../components/PrimaryButton.jsx';
import { getFamilyInvite } from '../../../api/client.js';

export const STEP_INDEX = 6;

// Backlog 1.3 — reused in Settings Home > "Invite a Co-Parent" (edit mode)
// and as the last real onboarding step before Preview, per Roy's ask that
// this be reachable from both places. The code and link both work: the
// share button hands over a clickable link (/join/CODE), and the code
// itself is shown large enough to read off one phone and type into another
// for whoever it gets sent through (text, WhatsApp, email — no in-app
// sending mechanism, just the OS share sheet or a copy button).
export default function InviteCoParentStep({ totalSteps, onNext, editMode = false, onDone }) {
  const [invite, setInvite] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getFamilyInvite().then(setInvite);
  }, []);

  async function share() {
    if (!invite) return;
    const shareData = { title: 'Join our Family App', text: 'Join our family on Family App', url: invite.joinUrl };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* user cancelled the share sheet — fall through to copy */
      }
    }
    await navigator.clipboard.writeText(invite.joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      {!editMode && <ProgressDots total={totalSteps} current={STEP_INDEX} />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 26, marginTop: -20 }}>
        <div style={{ alignSelf: 'center', width: 96, height: 96, borderRadius: '50%', background: color.accentSettingsTint, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="ms" style={{ fontSize: 52, color: color.accentSettings }}>group_add</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ font: `${weight.heavy} 30px/1.2 Nunito, sans-serif`, color: color.ink, textAlign: 'center', letterSpacing: '-.4px' }}>
            Invite a co-parent
          </div>
          <div style={{ font: `${weight.semibold} 17px/1.5 Nunito, sans-serif`, color: ink(0.52), textAlign: 'center' }}>
            Same calendar, same kids, same bot — they just need this code.
          </div>
        </div>

        {invite && (
          <div style={{ background: color.white, borderRadius: 24, padding: '22px 20px', boxShadow: `0 2px 8px ${ink(0.07)}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ font: `${weight.heavy} 34px/1.2 Nunito, sans-serif`, color: color.ink, letterSpacing: '.12em' }}>
              {invite.code}
            </div>
            <div style={{ font: `${weight.semibold} 13.5px/1.3 Nunito, sans-serif`, color: ink(0.42) }}>
              {invite.parentCount > 1 ? `${invite.parentCount} parents already in` : 'Just you so far'}
            </div>
          </div>
        )}

        <button
          onClick={share}
          disabled={!invite}
          style={{
            alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 8,
            background: 'none', border: `1.5px solid ${ink(0.14)}`, borderRadius: 20, padding: '10px 20px',
            cursor: invite ? 'pointer' : 'default',
          }}
        >
          <span className="ms" style={{ fontSize: 19, color: ink(0.5) }}>{copied ? 'check' : 'ios_share'}</span>
          <span style={{ font: `${weight.bold} 14.5px/1 Nunito, sans-serif`, color: ink(0.5) }}>
            {copied ? 'Link copied' : 'Share invite link'}
          </span>
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        <PrimaryButton onClick={() => (editMode ? onDone?.() : onNext())}>
          {editMode ? 'Done' : 'Continue'}
        </PrimaryButton>
      </div>
    </>
  );
}
