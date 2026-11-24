import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseQueryResult } from '@tanstack/react-query';
import { Check, Copy, ImageOff, Lock, LogIn, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Outlet, useLocation, useOutletContext, useParams } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, EmptyState, ErrorState, LinkButton, NavTabs, PageLoader, cx, toast } from '@/ui';

export type Role = 'owner' | 'admin' | 'editor' | 'analyst';
const RANK: Record<Role, number> = { analyst: 1, editor: 2, admin: 3, owner: 4 };
export const can = (role: Role, min: Role) => RANK[role] >= RANK[min];
export const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including deleting the brand and managing owners',
  admin: 'Settings, money, codes, team and all content',
  editor: 'Create and edit series, releases and pages',
  analyst: 'View content and analytics only',
};

export type StudioBrand = {
  id: string; slug: string; name: string; kind: 'creator' | 'publisher'; kind_requested: 'creator' | 'publisher' | null; bio: string;
  avatar_url: string | null; banner_url: string | null; website: string | null; socials: Record<string, string>; country: string | null;
  timezone: string | null; primary_language: string; ga_tracking_id: string | null; membership_note: string; tips_enabled: boolean;
  monthly_goal_cents: number | null; verified: boolean; suspended: boolean; suspend_reason: string | null; payout_configured: boolean;
  created_at: string; role: Role; series_count: number; member_count: number;
};

export function useBrands(enabled = true) {
  return useQuery({ queryKey: ['studio', 'brands'], queryFn: () => api<{ brands: StudioBrand[] }>('/api/studio/brands'), enabled });
}

export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · AltComix Studio`;
  }, [title]);
}

/** Loading / error handling for one query; children get the data. */
export function Q<T>({ query, children, loader }: { query: UseQueryResult<T>; children: (data: T) => ReactNode; loader?: ReactNode }) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <ErrorState message={errorMessage(query.error)} retry={() => query.refetch()} />;
  return <>{loader ?? <PageLoader />}</>;
}

/** Mutation with the house rules: toast on success, server message on failure, invalidate what changed. */
export function useAct<V = void, R = unknown>(fn: (v: V) => Promise<R>, opts: { success?: string | ((r: R, v: V) => string | null); invalidate?: QueryKey[]; onDone?: (r: R, v: V) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r, v) => {
      const msg = typeof opts.success === 'function' ? opts.success(r, v) : opts.success;
      if (msg) toast.success(msg);
      for (const key of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: key });
      opts.onDone?.(r, v);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function SignInNeeded({ what = 'the Studio' }: { what?: string }) {
  const loc = useLocation();
  const next = encodeURIComponent(loc.pathname + loc.search);
  return (
    <EmptyState icon={<LogIn />} title={`Sign in to open ${what}`} action={<div className="flex gap-2"><LinkButton to={`/login?next=${next}`} variant="primary">Sign in</LinkButton><LinkButton to={`/register?next=${next}`}>Create an account</LinkButton></div>}>
      The Studio is where you publish and manage your comics. It is free to use.
    </EmptyState>
  );
}

export function NoAccess() {
  return (
    <EmptyState icon={<Lock />} title="You do not have access to this brand" action={<LinkButton to="/studio" variant="primary">Go to your brands</LinkButton>}>
      You are signed in, but your account is not a member of this brand. Ask one of its owners to invite you from Settings, Team.
    </EmptyState>
  );
}

type BrandCtx = { brand: StudioBrand; role: Role };

/** Layout route: signed in and a member of `:brand`, or a clear explanation. */
export function BrandGuard() {
  const { user } = useSession();
  const { brand: slug } = useParams();
  const brands = useBrands(Boolean(user));
  if (!user) return <SignInNeeded />;
  return (
    <Q query={brands}>
      {(d) => {
        const brand = d.brands.find((b) => b.slug === slug);
        if (!brand) return <NoAccess />;
        return <Outlet context={{ brand, role: brand.role } satisfies BrandCtx} />;
      }}
    </Q>
  );
}

export function useBrand(): BrandCtx {
  return useOutletContext<BrandCtx>();
}

/** Brand-level page frame: name, top tabs, then the page. */
export function BrandPage({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  const { brand, role } = useBrand();
  useTitle(`${title} · ${brand.name}`);
  const base = `/studio/${brand.slug}`;
  const tabs = [
    { to: base, label: 'Series', end: true },
    { to: `${base}/analytics`, label: 'Analytics' },
    ...(can(role, 'admin') ? [{ to: `${base}/earnings`, label: 'Earnings' }] : []),
    ...(can(role, 'editor') ? [{ to: `${base}/codes`, label: 'Codes' }, { to: `${base}/store`, label: 'Bundles and sales' }] : []),
    { to: `${base}/settings`, label: 'Settings' },
  ];
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {brand.avatar_url ? <img src={brand.avatar_url} alt="" className="size-11 rounded-xl border border-line object-cover" /> : <span className="flex size-11 items-center justify-center rounded-xl border border-line bg-raised font-display text-lg font-bold text-muted" aria-hidden>{brand.name[0]?.toUpperCase()}</span>}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold sm:text-2xl">{brand.name}</h1>
            <p className="text-xs text-muted">
              <Link to="/studio" className="hover:text-paper">Studio</Link> · {brand.kind === 'publisher' ? 'Publisher' : 'Creator'} · your role: {role}
            </p>
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {brand.suspended && <div className="mb-4"><ErrorState message={`This brand is suspended${brand.suspend_reason ? `: ${brand.suspend_reason}` : ''}. Its comics are hidden from readers until support lifts the suspension.`} /></div>}
      <NavTabs tabs={tabs} />
      {children}
    </div>
  );
}

export function RoleNotice({ need }: { need: Role }) {
  return <EmptyState icon={<Lock />} title="Your role cannot open this">This part of the Studio needs the {need} role or higher. Ask a brand owner to change your role in Settings, Team.</EmptyState>;
}

export function CopyButton({ text, label = 'Copy', size = 'sm' }: { text: string; label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      icon={done ? <Check className="size-4" /> : <Copy className="size-4" />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error('Could not copy. Select the text and copy it by hand.');
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/** 2:3 cover with a neutral stand-in when there is none. */
export function Cover({ src, alt, className }: { src: string | null | undefined; alt: string; className?: string }) {
  return (
    <div className={cx('aspect-[2/3] overflow-hidden rounded-lg border border-line bg-raised', className)}>
      {src ? <img src={src} alt={alt} loading="lazy" className="size-full object-cover" /> : <div className="flex size-full items-center justify-center text-faint"><ImageOff className="size-6" aria-label="No cover yet" /></div>}
    </div>
  );
}

export function FileButton({ accept, multiple, onFiles, children, variant = 'secondary', loading, size = 'md' }: { accept: string; multiple?: boolean; onFiles: (f: File[]) => void; children: ReactNode; variant?: 'primary' | 'secondary'; loading?: boolean; size?: 'sm' | 'md' }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept={accept} multiple={multiple} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) onFiles(f); }} />
      <Button variant={variant} size={size} loading={loading} icon={<Upload className="size-4" />} onClick={() => ref.current?.click()}>{children}</Button>
    </>
  );
}

export const IMAGE_TYPES = 'image/png,image/jpeg,image/webp';
export const PAGE_TYPES = `${IMAGE_TYPES},.zip,.cbz,.pdf,application/pdf,application/zip`;

/** <input type="datetime-local"> value from an ISO instant, in the browser's timezone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const bps = (n: number) => `${(n / 100).toFixed(n % 100 ? 1 : 0)}%`;

const COUNTRY_CODES = 'AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FR GA GB GD GE GH GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KM KR KW KZ LA LB LI LK LR LS LT LU LV LY MA MC MD ME MG MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ OM PA PE PG PH PK PL PR PS PT PY QA RO RS RU RW SA SC SD SE SG SI SK SL SN SO SR SV SY TD TG TH TJ TM TN TR TT TW TZ UA UG US UY UZ VE VN YE ZA ZM ZW'.split(' ');
const regionNames = new Intl.DisplayNames(undefined, { type: 'region' });
export function countryName(code: string | null | undefined): string {
  if (!code) return '—';
  if (code === 'unknown') return 'Unknown';
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
export const COUNTRIES = COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name));
export const TIMEZONES: string[] = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];

export const STATUS_TONE = { draft: 'neutral', scheduled: 'info', published: 'ok' } as const;
export const VISIBILITY_LABEL: Record<string, string> = { draft: 'Draft', public: 'Public', unlisted: 'Unlisted' };
export const ACCESS_LABEL: Record<string, string> = { blocked: 'Blocked', free: 'Free', premium: 'Premium' };
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/** Section card with a heading, used all over the editors. */
export function Section({ title, description, actions, children, id }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="space-y-4 px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

/** Tracks a server object being edited: `dirty` when the form differs, reset when the server copy changes. */
export function useDraft<T>(server: T): [T, (patch: Partial<T>) => void, boolean, () => void] {
  const [draft, setDraft] = useState(server);
  const key = JSON.stringify(server);
  const last = useRef(key);
  useEffect(() => {
    if (last.current !== key) {
      last.current = key;
      setDraft(server);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [draft, (patch) => setDraft((d) => ({ ...d, ...patch })), JSON.stringify(draft) !== key, () => setDraft(server)];
}

/** Only the fields that differ, for PATCH bodies. */
export function changed<T extends object>(before: T, after: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(after) as (keyof T)[]) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = after[k];
  return out;
}

/** Label + hint for controls that are not a single input (button groups, multi-selects). A <label> would forward clicks to the first button. */
export function Group({ label, hint, children, className, optional }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; optional?: boolean }) {
  return (
    <div role="group" aria-label={typeof label === 'string' ? label : undefined} className={className}>
      <span className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px] font-medium text-paper"><span>{label}</span>{optional && <span className="text-xs font-normal text-faint">Optional</span>}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-faint">{hint}</span>}
    </div>
  );
}
