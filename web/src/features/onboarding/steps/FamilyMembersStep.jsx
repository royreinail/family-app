import { useEffect, useState } from 'react';
import { color, ink, weight, personPalette, kidIconChoices } from '../../../theme/tokens.js';
import ProgressDots from '../../../components/ProgressDots.jsx';
import PrimaryButton from '../../../components/PrimaryButton.jsx';
import { getFamilyMembers, createFamilyMember, updateFamilyMember, deleteFamilyMember } from '../../../api/client.js';

export const STEP_INDEX = 2;

const BLANK_DRAFT = { id: null, name: '', calendarColor: '', kidIcon: kidIconChoices[0] };

function nextUnusedColor(members) {
  const used = new Set(members.map((m) => m.calendar_color));
  return personPalette.find((c) => !used.has(c)) ?? personPalette[members.length % personPalette.length];
}

function draftFromMember(m) {
  return { id: m.id, name: m.name, calendarColor: m.calendar_color, kidIcon: m.kid_icon };
}

/**
 * Reused as-is in Settings Home > Family Members (edit mode) — the same
 * component runs the onboarding step and the later single-screen edit.
 *
 * The one card below serves double duty: tapping an existing member's chip
 * loads them into it for editing (draft.id set); tapping "+ New person" (or
 * finishing a save) resets it to a blank create-new draft (draft.id null).
 */
export default function FamilyMembersStep({ totalSteps, onNext, editMode = false, onDone }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(BLANK_DRAFT);
  // Two-tap "Remove" — first tap arms it, second (within a few seconds)
  // actually deletes. Keeps the gentle, no-modal-dialog tone the rest of the
  // app uses instead of a native confirm() popup.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    getFamilyMembers().then(({ members }) => {
      setMembers(members);
      setDraft((d) => ({ ...d, calendarColor: nextUnusedColor(members) }));
      setLoading(false);
    });
  }, []);

  function selectDraft(nextDraft) {
    setConfirmingRemove(false);
    setDraft(nextDraft);
  }

  function startNewPerson(currentMembers = members) {
    selectDraft({ ...BLANK_DRAFT, calendarColor: nextUnusedColor(currentMembers), kidIcon: kidIconChoices[currentMembers.length % kidIconChoices.length] });
  }

  async function saveMember() {
    if (!draft.name.trim()) return;
    const { name, calendarColor, kidIcon } = draft;
    if (draft.id) {
      const { member } = await updateFamilyMember(draft.id, { name, calendarColor, kidIcon });
      const updated = members.map((m) => (m.id === member.id ? member : m));
      setMembers(updated);
      startNewPerson(updated);
    } else {
      const { member } = await createFamilyMember({ name, calendarColor, kidIcon });
      const updated = [...members, member];
      setMembers(updated);
      startNewPerson(updated);
    }
  }

  async function removeMember() {
    if (!draft.id) return;
    if (!confirmingRemove) {
      setConfirmingRemove(true);
      return;
    }
    await deleteFamilyMember(draft.id);
    const updated = members.filter((m) => m.id !== draft.id);
    setMembers(updated);
    startNewPerson(updated);
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
              <button
                key={m.id}
                onClick={() => selectDraft(draftFromMember(m))}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                <div style={{
                  width: 52, height: 52, borderRadius: '50%', background: m.calendar_color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: draft.id === m.id ? `0 0 0 3px ${color.surface}, 0 0 0 6px ${m.calendar_color}` : 'none',
                }}>
                  <span style={{ fontSize: 28 }}>{m.kid_icon}</span>
                </div>
                <div style={{ font: `${weight.bold} 13px/1 Nunito, sans-serif`, color: ink(0.5) }}>{m.name}</div>
              </button>
            ))}
            {draft.id && (
              <button
                onClick={() => startNewPerson()}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                <div style={{
                  width: 52, height: 52, borderRadius: '50%', background: color.surfaceInset,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <span className="ms" style={{ fontSize: 24, color: ink(0.4) }}>add</span>
                </div>
                <div style={{ font: `${weight.bold} 13px/1 Nunito, sans-serif`, color: ink(0.4) }}>New person</div>
              </button>
            )}
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
                aria-label={c}
                style={{
                  width: 40, height: 40, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                  // Real bug: this used to dim unselected swatches to 0.55
                  // opacity, so every swatch read as a lighter, washed-out
                  // version of its actual color right up until it was picked
                  // — the moment of selection visibly snapped to a darker,
                  // more saturated shade, because THAT full-opacity value was
                  // always what actually got applied to the Calendar event
                  // (personPalette is the real hex, no separate "swatch tint").
                  // Selection state now lives only in the ring, so what's
                  // shown always matches what's assigned.
                  boxShadow: draft.calendarColor === c ? `0 0 0 3px ${color.surface}, 0 0 0 6px ${c}` : 'none',
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
            onClick={saveMember}
            disabled={!draft.name.trim()}
            style={{
              marginTop: 16, width: '100%', height: 44, borderRadius: 22, border: 'none',
              background: draft.name.trim() ? color.personPurple : color.surfaceInset,
              color: draft.name.trim() ? '#fff' : ink(0.4),
              font: `${weight.heavy} 15px/1 Nunito, sans-serif`, cursor: draft.name.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            {draft.id ? 'Save changes' : '+ Add to family'}
          </button>

          {draft.id && (
            <button
              onClick={removeMember}
              style={{
                marginTop: 10, width: '100%', height: 36, borderRadius: 18, border: 'none',
                background: confirmingRemove ? '#d9645a' : 'transparent',
                color: confirmingRemove ? '#fff' : ink(0.4),
                font: `${weight.bold} 13.5px/1 Nunito, sans-serif`, cursor: 'pointer',
              }}
            >
              {confirmingRemove ? 'Tap again to remove' : `Remove ${draft.name || 'from family'}`}
            </button>
          )}
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
