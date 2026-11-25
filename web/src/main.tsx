import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { ApiError, api } from '@/lib/api';
import { SessionProvider } from '@/lib/session';
import { Button, ConfirmProvider, PageLoader } from '@/ui';
import { router } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

// Report uncaught client errors to the self-hosted error log.
let reported = 0;
// Errors thrown by code that is not ours: scripts an app's built-in browser injects into the
// page (Facebook and Instagram use iabjs://, others webkit-masked-url://), browser extensions,
// and cross-origin scripts the browser will not describe ("Script error."). Nothing here can fix them.
const NOT_OURS = /(iabjs|chrome-extension|moz-extension|safari-extension|safari-web-extension|webkit-masked-url):\/\//i;
function report(message: string, stack?: string) {
  if (NOT_OURS.test(stack ?? '') || NOT_OURS.test(message) || /Java object is gone|^Script error\.?$/i.test(message)) return;
  if (reported++ > 5) return;
  api('/api/track/error', { json: { message: message.slice(0, 500), stack: stack?.slice(0, 4000), url: location.href } }).catch(() => {});
}
window.addEventListener('error', (e) => report(e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r instanceof ApiError) return; // handled failures surfaced to the user
  report(String(r?.message ?? r), r?.stack);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider
        fallback={<PageLoader label="Opening NSFWComix" />}
        failure={(message, retry) => (
          <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
            <h1 className="text-2xl font-bold">NSFWComix is not responding</h1>
            <p className="max-w-md text-muted">{message}</p>
            <Button variant="primary" onClick={retry}>Try again</Button>
          </div>
        )}
      >
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </SessionProvider>
      <Toaster theme="dark" position="bottom-center" toastOptions={{ style: { background: 'var(--color-raised)', border: '1px solid var(--color-line-strong)', color: 'var(--color-paper)' } }} />
    </QueryClientProvider>
  </StrictMode>,
);
