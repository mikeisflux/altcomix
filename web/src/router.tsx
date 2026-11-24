import { createBrowserRouter, isRouteErrorResponse, Link, useRouteError, useRoutes } from 'react-router';
import type { RouteObject } from 'react-router';
import { AppShell, AuthLayout } from '@/layout/AppShell';
import { Button, LinkButton } from '@/ui';
import { accountRoutes } from './areas/account/routes';
import { authRoutes } from './areas/auth/routes';
import { readerBareRoutes } from './areas/reader/routes';
import { storeRoutes } from './areas/store/routes';

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

/**
 * Studio and Admin are big and most readers never open them, so each loads as
 * its own chunk the first time someone visits a path under its prefix. The
 * area's routes are written with absolute paths; here they are re-based under
 * `<prefix>/*`.
 */
function lazyArea(prefix: string, load: () => Promise<RouteObject[]>): RouteObject {
  return {
    path: `${prefix}/*`,
    lazy: async () => {
      const routes: RouteObject[] = (await load()).map((r) => {
        const rest = (r.path ?? '').slice(prefix.length).replace(/^\//, '');
        if (rest) return { ...r, path: rest } as RouteObject;
        return r.children ? ({ ...r, path: undefined } as RouteObject) : ({ index: true, element: r.element } as RouteObject);
      });
      routes.push({ path: '*', element: <NotFound /> });
      const Area = () => useRoutes(routes);
      return { Component: Area };
    },
  };
}

export const router = createBrowserRouter([
  ...readerBareRoutes.map((r) => ({ ...r, errorElement: <RouteError /> })),
  {
    path: '/studio/:brand/series/:series/releases/:release/pages/:page',
    errorElement: <RouteError />,
    lazy: async () => ({ element: (await import('./areas/studio/routes')).studioBareRoutes[0].element }),
  },
  { element: <AuthLayout />, errorElement: <RouteError />, children: authRoutes },
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { errorElement: <RouteError />, children: [
          ...storeRoutes,
          ...accountRoutes,
          lazyArea('/studio', async () => (await import('./areas/studio/routes')).studioRoutes),
          lazyArea('/admin', async () => (await import('./areas/admin/routes')).adminRoutes),
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);
