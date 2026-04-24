import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import App from './App';
import './lib/i18n';
import './styles/index.css';

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
