import { useEffect, useState } from 'react';
import { color, ink, weight, radius } from '../../theme/tokens.js';
import PrimaryButton from '../../components/PrimaryButton.jsx';
import { getCalendarList, setSelectedCalendar } from '../../api/client.js';

// Settings Home > Calendar (backlog 2.1). Settings-only — there's nothing to
// pick during onboarding since a freshly-connected account only has its own
// calendars to choose from anyway; this matters once a family adds a shared
// household calendar later and wants events to land there instead of a
// personal one.
export default function CalendarSettings({ onDone }) {
  const [state, setState] = useState({ loading: true, connected: false, calendars: [], error: null });
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getCalendarList()
      .then(({ connected, calendars, selectedCalendarId, error }) => {
        setState({ loading: false, connected, calendars, error: error ?? null });
        setSelected(selectedCalendarId);
      })
      .catch((err) => {
        // The list-fetch route only ever throws (rather than resolving with
        // connected:false) when Google Calendar IS connected but the live
        // API call itself failed (502 calendar_unavailable) — a clean "not
        // connected" is always a normal 200. So a thrown error here always
        // means "connected, but couldn't load right now," never "connect it
        // first" — showing the wrong one of those two messages would send
        // someone on a pointless hunt for a non-existent connect button.
        setState({ loading: false, connected: true, calendars: [], error: err.message });
      });
  }, []);

  async function save() {
    if (!selected) return;
    setSaving(true);
    await setSelectedCalendar(selected);
    setSaving(false);
    onDone?.();
  }

  return (
    <>
      <div style={{ padding: '26px 4px 18px' }}>
        <div style={{ font: `${weight.heavy} 30px/1.2 Nunito, sans-serif`, color: color.ink, letterSpacing: '-.4px' }}>Which calendar?</div>
        <div style={{ font: `${weight.semibold} 17px/1.45 Nunito, sans-serif`, color: ink(0.48), marginTop: 6 }}>
          New events from the bot get written here.
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
        {state.loading && (
          <div style={{ font: `${weight.semibold} 15px/1.4 Nunito, sans-serif`, color: ink(0.4), padding: '4px 6px' }}>Loading your calendars…</div>
        )}

        {!state.loading && !state.connected && (
          <div style={{ background: color.white, borderRadius: radius.lg, padding: 20, boxShadow: `0 2px 6px ${ink(0.06)}` }}>
            <div style={{ font: `${weight.bold} 16px/1.4 Nunito, sans-serif`, color: ink(0.55) }}>
              Google Calendar isn't connected yet — connect it from Settings first, then come back here to
              pick which calendar to use.
            </div>
          </div>
        )}

        {!state.loading && state.connected && state.error && (
          <div style={{ background: color.white, borderRadius: radius.lg, padding: 20, boxShadow: `0 2px 6px ${ink(0.06)}` }}>
            <div style={{ font: `${weight.bold} 16px/1.4 Nunito, sans-serif`, color: ink(0.55) }}>
              Couldn't load your calendars just now. Your current selection is unchanged — try again in a bit.
            </div>
          </div>
        )}

        {!state.loading && state.connected && !state.error && state.calendars.map((cal) => (
          <button
            key={cal.id}
            onClick={() => setSelected(cal.id)}
            style={{
              background: color.white, borderRadius: radius.lg, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14,
              boxShadow: selected === cal.id ? `0 0 0 2px ${color.accentCalendar}` : `0 2px 6px ${ink(0.06)}`,
              border: 'none', cursor: 'pointer', textAlign: 'left',
            }}
          >
            <span className="ms" style={{ fontSize: 24, color: selected === cal.id ? color.accentCalendar : ink(0.3) }}>
              {selected === cal.id ? 'radio_button_checked' : 'radio_button_unchecked'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: `${weight.heavy} 16px/1.3 Nunito, sans-serif`, color: color.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cal.summary}
              </div>
              {cal.primary && (
                <div style={{ font: `${weight.bold} 12.5px/1 Nunito, sans-serif`, color: ink(0.4), marginTop: 3 }}>Your main calendar</div>
              )}
            </div>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <PrimaryButton onClick={save} disabled={!selected || saving}>
          {saving ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>
    </>
  );
}
