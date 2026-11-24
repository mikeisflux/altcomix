import type { RouteObject } from 'react-router';
import { Analytics } from './Analytics';
import { CodesPage } from './Codes';
import { EarningsPage } from './Earnings';
import { FramePage } from './FramePage';
import { ReleaseEditor } from './ReleaseEditor';
import { SeriesList, SeriesNew } from './Series';
import { SeriesAdvanced } from './SeriesAdvanced';
import { SeriesDetails } from './SeriesDetails';
import { SeriesEditor } from './SeriesEditor';
import { SeriesPaywall } from './SeriesPaywall';
import { SeriesReleases } from './SeriesReleases';
import { SettingsPage } from './Settings';
import { StorePage } from './Store';
import { AcceptInvite, StudioHome } from './StudioHome';
import { BrandGuard } from './shared';

export const studioRoutes: RouteObject[] = [
  { path: '/studio', element: <StudioHome /> },
  // The invitation email links to /studio/invite?token=…; the path form is kept as an alias.
  { path: '/studio/invite', element: <AcceptInvite /> },
  { path: '/studio/invite/:token', element: <AcceptInvite /> },
  {
    path: '/studio/:brand',
    element: <BrandGuard />,
    children: [
      { index: true, element: <SeriesList /> },
      { path: 'new', element: <SeriesNew /> },
      { path: 'analytics', element: <Analytics /> },
      { path: 'earnings', element: <EarningsPage /> },
      { path: 'codes', element: <CodesPage /> },
      { path: 'store', element: <StorePage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/:section', element: <SettingsPage /> },
      {
        path: 'series/:series',
        element: <SeriesEditor />,
        children: [
          { index: true, element: <SeriesReleases /> },
          { path: 'details', element: <SeriesDetails /> },
          { path: 'paywall', element: <SeriesPaywall /> },
          { path: 'advanced', element: <SeriesAdvanced /> },
        ],
      },
      { path: 'series/:series/releases/:release', element: <ReleaseEditor /> },
    ],
  },
];

export const studioBareRoutes: RouteObject[] = [{ path: '/studio/:brand/series/:series/releases/:release/pages/:page', element: <FramePage /> }];
