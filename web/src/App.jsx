import { Routes, Route, Navigate } from 'react-router-dom';
import { useFamily } from './context/FamilyContext.jsx';
import OnboardingFlow from './features/onboarding/OnboardingFlow.jsx';
import JoinFamilyPage from './features/onboarding/JoinFamilyPage.jsx';
import TomorrowBoardPage from './features/kid-dashboard/TomorrowBoardPage.jsx';
import SettingsPage from './features/settings/SettingsPage.jsx';
import { color } from './theme/tokens.js';

function RootRedirect() {
  const { session, loading } = useFamily();
  if (loading) return <div style={{ minHeight: '100vh', background: color.page }} />;
  // PIN is explicitly skippable during onboarding ("I'll set this up
  // later") — it must never gate whether someone counts as "done", or a
  // family that skipped it gets sent through the *entire* onboarding
  // sequence again on every fresh session (any new device/browser, cookie
  // cleared, etc.), forever. calendarConnected is the one real hard
  // requirement; everything else (members, timezone, WhatsApp, PIN) is
  // editable later from Settings.
  const onboarded = session?.signedIn && session?.calendarConnected;
  return <Navigate to={onboarded ? '/dashboard' : '/onboarding'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/onboarding" element={<OnboardingFlow />} />
      <Route path="/join/:code" element={<JoinFamilyPage />} />
      <Route path="/dashboard" element={<TomorrowBoardPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>
  );
}
