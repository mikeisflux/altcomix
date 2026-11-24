import { Lock, Sparkles, Ticket } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ConfirmEmailPrompt } from '@/areas/store/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button, LinkButton, toast } from '@/ui';
import type { Manifest, ReaderPage } from './model';

/** Shown in place of a page the reader cannot open yet. */
export function Paywall({ manifest, page, onUnlocked, compact }: { manifest: Manifest; page: ReaderPage; onUnlocked: () => void; compact?: boolean }) {
  const { user, settings, currency, refresh } = useSession();
  const loc = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  // Buying needs a confirmed email; the server says so with code `email_unverified`.
  const [unverified, setUnverified] = useState<string | null>(null);
  const { offers, release, series, access } = manifest;
  const next = encodeURIComponent(loc.pathname + loc.search);

  const checkout = async (kind: 'release' | 'series') => {
    setBusy(kind);
    try {
      const r = await api<{ url?: string; completed?: boolean }>('/api/checkout', {
        json: { items: [{ kind, id: kind === 'release' ? release.id : series.id }], return_to: loc.pathname },
      });
      if (r.url) {
        window.location.assign(r.url);
        return;
      }
      toast.success('Unlocked. Enjoy!');
      await refresh();
      onUnlocked();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'email_unverified') setUnverified(e.message);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const spendCredit = async () => {
    setBusy('credit');
    try {
      await api(`/api/pages/${page.id}/unlock`, { method: 'POST' });
      await refresh();
      onUnlocked();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'email_unverified') setUnverified(e.message);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const onSale = offers.read_list_price_cents !== null && offers.read_price_cents !== null && offers.read_list_price_cents > offers.read_price_cents;

  return (
    <div className={compact ? 'mx-auto w-full max-w-md p-5' : 'mx-auto flex h-full w-full max-w-md flex-col justify-center p-5'}>
      <div className="rounded-2xl border border-line-strong bg-surface p-6 text-center shadow-pop">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-hover"><Lock className="size-5" /></div>
        <h2 className="text-xl font-bold">Keep reading {release.title}</h2>
        <p className="mt-1.5 text-sm text-muted">
          {access.free_pages > 0 ? `That was the free preview (${access.free_pages} of ${release.page_count} pages).` : 'This release is for supporters.'}{' '}
          Your purchase goes to {series.publisher.name}.
        </p>

        {unverified && <div className="mt-4 text-left"><ConfirmEmailPrompt message={unverified} onConfirmed={() => setUnverified(null)} /></div>}

        <div className="mt-5 space-y-2.5">
          {!user && <LinkButton to={`/login?next=${next}`} variant="secondary" block>Sign in to continue</LinkButton>}

          {offers.read_price_cents !== null && offers.read_price_cents > 0 && (
            <Button variant="primary" size="lg" block loading={busy === 'release'} disabled={!user} onClick={() => checkout('release')}>
              Buy this release · {onSale && <s className="mx-1 font-normal opacity-70">{money(offers.read_list_price_cents, currency)}</s>}{money(offers.read_price_cents, currency)}
            </Button>
          )}
          {offers.series_price_cents !== null && offers.series_price_cents > 0 && (
            <Button variant="secondary" block loading={busy === 'series'} disabled={!user} onClick={() => checkout('series')}>
              Buy the whole series · {money(offers.series_price_cents, currency)}
            </Button>
          )}
          {offers.in_membership && (
            <LinkButton to={`/unlimited?next=${next}`} variant={offers.read_price_cents ? 'secondary' : 'primary'} block icon={<Sparkles className="size-4" />}>
              Read with {settings.membership.name} · {money(settings.membership.monthly_cents, currency)}/mo
            </LinkButton>
          )}
          {user && offers.page_credits_available > 0 && (
            <Button variant="ghost" block loading={busy === 'credit'} onClick={spendCredit}>
              Unlock just this page with 1 credit ({offers.page_credits_available} left)
            </Button>
          )}
          {offers.read_price_cents === null && !offers.in_membership && (
            <p className="text-sm text-muted">This release is not on sale yet. Follow the series to hear when it is.</p>
          )}
        </div>

        <div className="mt-5 flex items-center justify-center gap-4 text-sm">
          <Link to={`/account/codes?next=${next}`} className="inline-flex items-center gap-1.5 text-muted hover:text-paper"><Ticket className="size-4" /> Have a code?</Link>
          <Link to={`/series/${series.slug}`} className="text-muted hover:text-paper">Back to series</Link>
        </div>
      </div>
    </div>
  );
}
