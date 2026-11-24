import { createBrowserRouter, isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AppShell, AuthLayout } from '@/layout/AppShell';
import { Button, LinkButton } from '@/ui';
import { accountRoutes } from './areas/account/routes';
import { adminRoutes } from './areas/admin/routes';
import { authRoutes } from './areas/auth/routes';
import { readerBareRoutes } from './areas/reader/routes';
import { storeRoutes } from './areas/store/routes';
import { studioBareRoutes, studioRoutes } from './areas/studio/routes';

/**
 * Each area owns its own `routes.tsx` and exports route arrays:
 *   xRoutes      rendered inside the main shell (top bar + sidebar)
 *   xBareRoutes  full-screen pages with no chrome (reader, frame editor)
 * Add pages in the area's file, not here.
 */

function RouteError() {
  const err = useRouteError();
  const notFound = isRouteErrorResponse(err) && err.status === 404;
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-bold">{notFound ? 'Page not found' : 'This page hit a problem'}</h1>
      <p className="max-w-md text-muted">
        {notFound ? 'The link may be old, or the page may have moved.' : 'The error has been reported. Reloading usually fixes it.'}
      </p>
      <div className="flex gap-2">
        {!notFound && <Button onClick={() => location.reload()}>Reload</Button>}
        <LinkButton to="/" variant="primary">Go to the store</LinkButton>
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="text-muted">The link may be old, or the page may have moved.</p>
      <Link to="/" className="link">Go to the store</Link>
    </div>
  );
}

export const router = createBrowserRouter([
  ...readerBareRoutes.map((r) => ({ ...r, errorElement: <RouteError /> })),
  ...studioBareRoutes.map((r) => ({ ...r, errorElement: <RouteError /> })),
  { element: <AuthLayout />, errorElement: <RouteError />, children: authRoutes },
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { errorElement: <RouteError />, children: [...storeRoutes, ...accountRoutes, ...studioRoutes, ...adminRoutes, { path: '*', element: <NotFound /> }] },
    ],
  },
]);
