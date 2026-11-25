import type { RouteObject } from 'react-router';
import { BrandPage, Creators } from './Brand';
import { Browse } from './Browse';
import { CheckoutReturn } from './Checkout';
import { CmsPageView, NewsList, NewsPost } from './Content';
import { GiftCards } from './GiftCards';
import { FirstVisit } from './firstVisit';
import { Home } from './Home';
import { SeriesPage } from './Series';
import { Unlimited } from './Unlimited';
import { Welcome } from './Welcome';

/** Public storefront. Cover and release cards for other areas live in ./cards. */
export const storeRoutes: RouteObject[] = [
  { path: '/', element: <FirstVisit><Home /></FirstVisit> },
  { path: '/welcome', element: <Welcome /> },
  { path: '/browse', element: <Browse /> },
  { path: '/series/:slug', element: <SeriesPage /> },
  { path: '/checkout/return', element: <CheckoutReturn /> },
  { path: '/b/:slug', element: <BrandPage /> },
  { path: '/creators', element: <Creators /> },
  { path: '/unlimited', element: <Unlimited /> },
  { path: '/gift-cards', element: <GiftCards /> },
  { path: '/p/:slug', element: <CmsPageView /> },
  { path: '/news', element: <NewsList /> },
  { path: '/news/:slug', element: <NewsPost /> },
];
