import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  // Relative base so the built index.html + lazy chunks resolve correctly
  // whether we're served from root (Vercel prod) or a proxy path (Perplexity
  // sites preview). Absolute `/assets/...` imports break under the proxy.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Bump the warning ceiling slightly — the PDF/Supabase chunks are the
    // largest and they're already split into their own vendor chunks below,
    // so there's nothing more to slice without churning the app bundle.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Function form: called once per module. We group node_modules
        // into stable vendor chunks so a one-file app change doesn't bust
        // every cached JS file.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            id.includes('/jspdf') ||
            id.includes('/jspdf-autotable') ||
            id.includes('/html2canvas')
          ) {
            return 'vendor-pdf';
          }
          if (id.includes('/@supabase/')) return 'vendor-supabase';
          if (
            id.includes('/react-hook-form') ||
            id.includes('/@hookform/') ||
            id.includes('/zod')
          ) {
            return 'vendor-forms';
          }
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router-dom/') ||
            id.includes('/@tanstack/react-query/')
          ) {
            return 'vendor-react';
          }
          return 'vendor-misc';
        },
      },
    },
  },
});
