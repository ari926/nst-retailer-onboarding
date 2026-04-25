import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import App from './App';
import './lib/i18n';
import './styles/index.css';

// Auto-seed a mock user for preview builds so reviewers skip the claim/MFA flow.
// Only runs when VITE_MOCK_AUTH=true and no user is already stored.
if (import.meta.env.VITE_MOCK_AUTH === 'true') {
  try {
    if (!localStorage.getItem('nst_mock_user')) {
      localStorage.setItem(
        'nst_mock_user',
        JSON.stringify({
          id: 'mock-preview-user',
          email: 'preview@talaria.com',
          _mock: true,
          user_metadata: {
            sfdc_account_id: 'SFDC-PREVIEW-001',
            first_name: 'Preview',
          },
        }),
      );
    }
  } catch {
    // localStorage unavailable — fall through to regular flow
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Hash routing under mock-auth (preview builds) so the app works when
          served from a proxied path. Production with a real domain uses
          BrowserRouter for clean URLs. */}
      {import.meta.env.VITE_MOCK_AUTH === 'true' ? (
        <HashRouter>
          <App />
          <Toaster position="top-right" />
        </HashRouter>
      ) : (
        <BrowserRouter>
          <App />
          <Toaster position="top-right" />
        </BrowserRouter>
      )}
    </QueryClientProvider>
  </React.StrictMode>,
);
