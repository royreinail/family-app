import { useEffect, useState } from 'react';
import { color, ink, weight, personPalette, kidIconChoices } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PrimaryButton from '../../../components/PrimaryButton.jsx';
import { getFamilyMembers, createFamilyMember, updateFamilyMember } from '../../../api/client.js';

export const STEP_INDEX = 2;

function nextUnusedColor(members) {
  const used = new Set(members.map((m) => m.calendar_color));
  return personPalette.find((c) => !used.has(c)) ?? personPalette[members.length % personPalette.length];
}

/**
 * Reused as-is in Settings Home > Family Members (edit mode) — the same
 * component runs the onboarding step and the later single-screen edit.
 */
export default function FamilyMembersStep({ totalSteps, onNext, editMode = false, onDone }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ name: '', calendarColor: '', kidIcon: kidIconChoices[0] });

  useEffect(() => {
    getFamilyMembers().then(({ members }) => {
      setMembers(members);
      setDraft((d) => ({ ...d, calendarColor: nextUnusedColor(members) }));
      setLoading(false);
    });
  }, []);

  async function addMember() {
    if (!draft.name.trim()) return;
    const { member } = await createFamilyMember(draft);
    const updated = [...members, member];
    setMembers(updated);
    setDraft({ name: '', calendarColor: nextUnusedColor(updated), kidIcon: kidIconChoices[updated.length % kidIconChoices.length] });
  }

  return (
    <>
      {!editMode && <ProgressDots total={totalSteps} current={STEP_INDEX} />}

      <div style={{ padding: '26px 4px 18px' }}>
        <div style={{ font: `${weight.heavy} 30px/1.2 Nunito, sans-serif`, color: color.ink, letterSpacing: '-.4px' }}>Who's in the family?</div>
        <div style={{ font: `${weight.semibold} 17px/1.45 Nunito, sans-serif`, color: ink(0.48), marginTop: 6 }}>
          A color and a face for each person — that's how kids tell the cards apart.
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
        {!loading && members.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, padding: '2px 6px 4px' }}>
            {members.map((m) => (
              <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: m.calendar_color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 28 }}>{m.kid_icon}</span>
                </div>
                <div style={{ font: `${weight.bold} 13px/1 Nunito, sans-serif`, color: ink(0.5) }}>{m.name}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ background: color.white, borderRadius: 24, padding: '18px 16px 20px', boxShadow: `0 3px 12px ${ink(0.1)}`, border: `2px solid ${color.personSage}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: draft.calendarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <span style={{ fontSize: 26 }}>{draft.kidIcon}</span>
            </div>
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Name"
              style={{
                flex: 1, border: 'none', borderBottom: `2px solid ${ink(0.12)}`, paddingBottom: 6,
                font: `${weight.heavy} 19px/1.2 Nunito, sans-serif`, color: color.ink, outline: 'none', background: 'transparent',
              }}
            />
          </div>

          <div style={{ font: `${weight.bold} 12.5px/1 Nunito, sans-serif`, color: ink(0.4), letterSpacing: '.06em', margin: '18px 0 10px' }}>COLOR</div>
          <div style={{ display: 'flex', gap: 10 }}>
            {personPalette.map((c) => (
              <button
                key={c}
                onClick={() => setDraft((d) => ({ ...d, calendarColor: c }))}
                style={{
                  width: 40, height: 40, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                  boxShadow: draft.calendarColor === c ? `0 0 0 3px ${color.surface}, 0 0 0 6px ${c}` : 'none',
                  opacity: draft.calendarColor === c ? 1 : 0.55,
                }}
              />
            ))}
          </div>

          <div style={{ font: `${weight.bold} 12.5px/1 Nunito, sans-serif`, color: ink(0.4), letterSpacing: '.06em', margin: '18px 0 10px' }}>ICON</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 7 }}>
            {kidIconChoices.map((icon) => (
              <button
                key={icon}
                onClick={() => setDraft((d) => ({ ...d, kidIcon: icon }))}
                style={{
                  height: 44, borderRadius: 14, border: 'none', cursor: 'pointer',
                  background: draft.kidIcon === icon ? color.personSage : color.surfaceInset,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24,
                }}
              >
                {icon}
              </button>
            ))}
          </div>

          <button
            onClick={addMember}
            disabled={!draft.name.trim()}
            style={{
              marginTop: 16, width: '100%', height: 44, borderRadius: 22, border: 'none',
              background: draft.name.trim() ? color.personPurple : color.surfaceInset,
              color: draft.name.trim() ? '#fff' : ink(0.4),
              font: `${weight.heavy} 15px/1 Nunito, sans-serif`, cursor: draft.name.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            + Add to family
          </button>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <PrimaryButton onClick={() => (editMode ? onDone?.() : onNext())} disabled={members.length === 0}>
          {editMode ? 'Save' : `Done — ${members.length} ${members.length === 1 ? 'person' : 'people'}`}
        </PrimaryButton>
      </div>
    </>
  );
}
