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
  const onboarded = session?.signedIn && session?.calendarConnected && session?.family?.pinSet;
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
