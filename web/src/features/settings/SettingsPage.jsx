import { useState } from 'react';
import { useFamily } from '../../context/FamilyContext.jsx';
import PhoneFrame from '../../components/PhoneFrame.jsx';
import PinGate from './PinGate.jsx';
import SettingsHome from './SettingsHome.jsx';
import FamilyMembersStep from '../onboarding/steps/FamilyMembersStep.jsx';
import TimezoneStep from '../onboarding/steps/TimezoneStep.jsx';
import WhatsAppStep from '../onboarding/steps/WhatsAppStep.jsx';
import PinStep from '../onboarding/steps/PinStep.jsx';
import InviteCoParentStep from '../onboarding/steps/InviteCoParentStep.jsx';
import CalendarSettings from './CalendarSettings.jsx';

// Reached via the kid dashboard's settings gear. PIN-gated (or, if no PIN
// has been set yet, passes straight through — nothing to verify against).
// Once past the gate: a menu, and each row jumps into that single
// onboarding-step component running in edit mode, returning to the menu
// when done — never a forced march through the full onboarding sequence.
export default function SettingsPage() {
  const { session, loading, refresh } = useFamily();
  const [verified, setVerified] = useState(false);
  const [forceNewPin, setForceNewPin] = useState(false);
  const [view, setView] = useState('menu');

  if (loading) return <PhoneFrame />;

  const pinRequired = !!session?.family?.pinSet;
  if (pinRequired && !verified) {
    return (
      <PinGate
        onVerified={(opts) => {
          setVerified(true);
          if (opts?.setNewPin) setForceNewPin(true);
        }}
      />
    );
  }

  if (forceNewPin) {
    return (
      <PhoneFrame>
        <PinStep
          editMode
          onDone={async () => {
            setForceNewPin(false);
            await refresh();
          }}
        />
      </PhoneFrame>
    );
  }

  const backToMenu = () => setView('menu');

  const editors = {
    'family-members': <FamilyMembersStep editMode onDone={backToMenu} />,
    timezone: <TimezoneStep editMode onDone={backToMenu} initialTimezone={session?.family?.timezone} />,
    whatsapp: <WhatsAppStep editMode onDone={backToMenu} />,
    calendar: <CalendarSettings onDone={backToMenu} />,
    pin: <PinStep editMode onDone={backToMenu} />,
    invite: <InviteCoParentStep editMode onDone={backToMenu} />,
  };

  if (view !== 'menu') {
    return <PhoneFrame onBack={backToMenu}>{editors[view]}</PhoneFrame>;
  }

  return <SettingsHome onSelect={setView} />;
}
