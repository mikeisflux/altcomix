import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { RouteObject } from 'react-router';
import { RequireUser } from '@/layout/AppShell';
import { Codes, Membership, Purchases, Receipt } from './Billing';
import { Community, ForumBoard, ForumIndexPage, ForumThread } from './Forums';
import { Library } from './Library';
import { Messages } from './Messages';
import { Feedback, GenrePicker, Notifications, UserProfile } from './Misc';
import { Settings } from './Settings';

const signedIn = (page: ReactNode) => <RequireUser>{page}</RequireUser>;

/** Backer-code emails link to /redeem?code=…; the form lives at /account/codes. The query string is kept. */
function RedeemRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/account/codes${search}`} replace />;
}

/**
 * Signed-in reader pages (library, account, messages) plus the community
 * pages, which anyone can read but only signed-in readers can post in.
 */
export const accountRoutes: RouteObject[] = [
  { path: '/library', element: signedIn(<Library />) },

  { path: '/account', element: signedIn(<Settings />) },
  { path: '/account/codes', element: signedIn(<Codes />) },
  { path: '/redeem', element: signedIn(<RedeemRedirect />) },
  { path: '/account/purchases', element: signedIn(<Purchases />) },
  { path: '/account/purchases/:orderId', element: signedIn(<Receipt />) },
  { path: '/account/membership', element: signedIn(<Membership />) },
  { path: '/onboarding/genre', element: signedIn(<GenrePicker />) },

  { path: '/notifications', element: signedIn(<Notifications />) },
  { path: '/messages', element: signedIn(<Messages />) },
  { path: '/messages/:conversationId', element: signedIn(<Messages />) },

  { path: '/community', element: <Community /> },
  { path: '/forums', element: <ForumIndexPage /> },
  { path: '/forums/thread/:threadId', element: <ForumThread /> },
  { path: '/forums/:board', element: <ForumBoard kind="board" /> },
  { path: '/series/:slug/forum', element: <ForumBoard kind="series" /> },

  { path: '/u/:username', element: <UserProfile /> },
  { path: '/feedback', element: <Feedback /> },
];
