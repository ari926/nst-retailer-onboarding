import { Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';

/**
 * App router — expanded incrementally across PRs.
 * PR #1: Home only.
 * PR #2: Adds /onboarding with layout shell + step routes.
 * PR #3: Adds /login, /claim, /mfa.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
