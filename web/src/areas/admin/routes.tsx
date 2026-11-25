import type { RouteObject } from 'react-router';
import { AdminLayout } from './AdminLayout';
import { CommentsPage, ReportsPage, SeriesPage } from './Catalog';
import { Dashboard } from './Dashboard';
import { EmailQueuePage, EmailTemplatesPage, SuppressionsPage } from './Email';
import { InboxPage, MailboxesPage } from './Inbox';
import { CodesPage, MembershipsPage, OrderDetail, OrdersPage, PayoutsPage, SalesTaxPage, SettlementPage } from './Finance';
import { AuditPage, CronPage, ErrorsPage } from './Logs';
import { BrandDetail, BrandsPage, UserDetail, UsersPage } from './People';
import { SecurityPage, TwoFactorPage } from './Security';
import { SettingsPage } from './Settings';
import { TaxPage } from './Tax';
import { AnnouncementsPage, FeaturedPage, FeedbackPage, NewsEditor, NewsPage, PageEditor, PagesPage } from './Storefront';
import { useTitle } from './shared';

function DashboardRoute() {
  useTitle('Dashboard');
  return <Dashboard />;
}

/** Everything under /admin, drawn inside the main shell with its own section navigation. */
export const adminRoutes: RouteObject[] = [
  {
    path: '/admin',
    element: <AdminLayout />,
    children: [
      { index: true, element: <DashboardRoute /> },
      { path: 'series', element: <SeriesPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'comments', element: <CommentsPage /> },
      { path: 'users', element: <UsersPage /> },
      { path: 'users/:id', element: <UserDetail /> },
      { path: 'brands', element: <BrandsPage /> },
      { path: 'brands/:id', element: <BrandDetail /> },
      { path: 'orders', element: <OrdersPage /> },
      { path: 'orders/:id', element: <OrderDetail /> },
      { path: 'memberships', element: <MembershipsPage /> },
      { path: 'payouts', element: <PayoutsPage /> },
      { path: 'settlement', element: <SettlementPage /> },
      { path: 'sales-tax', element: <SalesTaxPage /> },
      { path: 'tax', element: <TaxPage /> },
      { path: 'codes', element: <CodesPage /> },
      { path: 'featured', element: <FeaturedPage /> },
      { path: 'announcements', element: <AnnouncementsPage /> },
      { path: 'pages', element: <PagesPage /> },
      { path: 'pages/:slug', element: <PageEditor /> },
      { path: 'news', element: <NewsPage /> },
      { path: 'news/:id', element: <NewsEditor /> },
      { path: 'feedback', element: <FeedbackPage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'inbox/mailboxes', element: <MailboxesPage /> },
      { path: 'email', element: <EmailQueuePage /> },
      { path: 'email/templates', element: <EmailTemplatesPage /> },
      { path: 'email/suppressions', element: <SuppressionsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'security', element: <SecurityPage /> },
      { path: 'security/2fa', element: <TwoFactorPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'errors', element: <ErrorsPage /> },
      { path: 'cron', element: <CronPage /> },
    ],
  },
];
