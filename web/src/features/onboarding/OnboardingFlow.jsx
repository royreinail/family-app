import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PhoneFrame from '../../components/PhoneFrame.jsx';
import { useFamily } from '../../context/FamilyContext.jsx';
import SignInStep from './steps/SignInStep.jsx';
import ConnectCalendarStep from './steps/ConnectCalendarStep.jsx';
import FamilyMembersStep from './steps/FamilyMembersStep.jsx';
import TimezoneStep from './steps/TimezoneStep.jsx';
import WhatsAppStep from './steps/WhatsAppStep.jsx';
import PinStep from './steps/PinStep.jsx';
import PreviewStep from './steps/PreviewStep.jsx';

// The 7-step sequential onboarding flow. Each step is its own reusable
// component (steps/*.jsx) — the same components later run individually in
// Settings Home edit mode, not a second build.
const TOTAL_STEPS = 7;

export default function OnboardingFlow() {
  const { session, loading, refresh } = useFamily();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (loading || initialized) return;
    if (session?.signedIn) {
      setStep(session.calendarConnected ? 2 : 1);
    }
    setInitialized(true);
  }, [loading, session, initialized]);

  if (loading) return <PhoneFrame />;

  const next = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS - 1));

  const steps = [
    <SignInStep totalSteps={TOTAL_STEPS} onNext={next} />,
    <ConnectCalendarStep totalSteps={TOTAL_STEPS} session={session} onNext={next} />,
    <FamilyMembersStep totalSteps={TOTAL_STEPS} onNext={next} />,
    <TimezoneStep totalSteps={TOTAL_STEPS} onNext={next} initialTimezone={session?.family?.timezone} />,
    <WhatsAppStep totalSteps={TOTAL_STEPS} onNext={next} />,
    <PinStep totalSteps={TOTAL_STEPS} onNext={next} />,
    <PreviewStep
      totalSteps={TOTAL_STEPS}
      onFinish={async () => {
        await refresh();
        navigate('/dashboard');
      }}
    />,
  ];

  return <PhoneFrame padding={step === 2 ? '56px 24px 40px' : '56px 28px 40px'}>{steps[step]}</PhoneFrame>;
}
