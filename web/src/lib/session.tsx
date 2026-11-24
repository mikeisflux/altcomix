import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type Brand = { id: string; slug: string; name: string; kind: 'creator' | 'publisher'; avatar_url: string | null; role: 'owner' | 'admin' | 'editor' | 'analyst' };

export type User = {
  id: string;
  email: string;
  username: string;
  display_name: string;
  role: 'user' | 'admin' | 'super_admin';
  email_verified: boolean;
  avatar_url: string | null;
  bio: string;
  prefs: Record<string, unknown> & { show_mature?: boolean; favorite_genre?: string; notify?: Record<string, boolean> };
  totp_enabled: boolean;
  member: boolean;
  brands: Brand[];
  wallet: { credit_cents: number; page_credits: number };
  unread_notifications: number;
  created_at: string;
};

type Option = { id: string; label: string };
export type Meta = {
  seriesTypes: Option[];
  genres: string[];
  themes: string[];
  eras: string[];
  audiences: string[];
  artStyles: string[];
  advisories: string[];
  contentRatings: string[];
  updateFrequencies: string[];
  seriesStatuses: string[];
  releaseGroups: { group: string; kinds: Option[] }[];
  contributorRoles: string[];
  crowdfundingServices: string[];
  favoriteGenres: { id: string; label: string; genres: string[]; type?: string }[];
  languages: { code: string; label: string }[];
  forumBoards: Option[];
};

export type PublicSettings = {
  site: { name: string; tagline: string; socials: Record<string, string>; registration_open: boolean; currency: string };
  membership: { name: string; monthly_cents: number; annual_cents: number; trial_days: number; page_credit_cents: number };
  payments: { provider: string };
  recaptcha_site_key: string;
  ga_measurement_id: string;
};

type Bootstrap = { settings: PublicSettings; meta: Meta; user: User | null };

type Session = Bootstrap & {
  /** Re-read the signed-in user (after login, purchase, settings change ...). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  isStaff: boolean;
  currency: string;
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children, fallback, failure }: { children: ReactNode; fallback: ReactNode; failure: (message: string, retry: () => void) => ReactNode }) {
  const qc = useQueryClient();
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap'), staleTime: 60_000, retry: 1 });

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['bootstrap'] });
  }, [qc]);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    qc.clear();
    window.location.assign('/');
  }, [qc]);

  const value = useMemo<Session | null>(() => {
    if (!boot.data) return null;
    const role = boot.data.user?.role;
    return { ...boot.data, refresh, logout, isStaff: role === 'admin' || role === 'super_admin', currency: boot.data.settings.site.currency };
  }, [boot.data, refresh, logout]);

  if (boot.isError && !boot.data) return <>{failure((boot.error as Error).message, () => boot.refetch())}</>;
  if (!value) return <>{fallback}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession must be used inside SessionProvider');
  return s;
}

export function languageLabel(meta: Meta, code: string): string {
  return meta.languages.find((l) => l.code === code)?.label ?? code;
}
