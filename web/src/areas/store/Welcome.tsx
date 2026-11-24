import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useSession } from '@/lib/session';
import { LinkButton, cx } from '@/ui';
import { useTitle } from './shared';

/**
 * The pitch: why AltComix exists. Linked from the footer, the Studio and the
 * signed-out home. Layout follows the "Marketing landing page" board in the
 * brand canvas; creator shares come from live settings, never hardcoded.
 */

function Eyebrow({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'sun' }) {
  return <div className={cx('text-[13px] font-semibold uppercase tracking-[0.14em]', tone === 'sun' ? 'text-sun' : 'text-accent-hover')}>{children}</div>;
}

function Dots({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cx('pointer-events-none absolute rounded-full opacity-50', className)}
      style={{ backgroundImage: 'radial-gradient(circle, var(--color-accent) 2.2px, transparent 2.6px)', backgroundSize: '14px 14px' }}
    />
  );
}

const PROMISES: [string, string][] = [
  ['Adult content is allowed', 'Sex, nudity and mature themes are welcome when the work is labelled for adults. Explicit is not a violation.'],
  ['Rules do not change overnight', 'Policy changes are announced in advance, and work published under the old rules is not pulled without a conversation first.'],
  ['A reason and an appeal, every time', 'If a title is ever taken down you are told which rule, by a person, and you can appeal to a person.'],
  ['Your work stays yours', 'Non-exclusive, no lock-in. Download your original files or remove a series whenever you like.'],
];

const EDGES: [string, string][] = [
  ['Adults only, in every sense.', 'No sexual content involving minors or characters presented as minors.'],
  ['No real people without consent.', 'No sexual depictions of real, identifiable people.'],
  ['Yours to publish.', 'No scans or work you do not hold the rights to.'],
  ['Label it.', 'Adult work is marked as adult so readers choose what they see.'],
];

export function Welcome() {
  useTitle('Your comic. Your rules.');
  const { settings, user } = useSession();
  const pct = (bps: number) => Math.round(bps / 100);
  const r = settings.revenue;
  const publish = user ? '/studio' : '/register?next=/studio';

  return (
    <div className="-mx-4 -my-6 overflow-hidden sm:-mx-6 lg:-mx-8">
      {/* Hero */}
      <section className="relative mx-auto flex max-w-6xl flex-wrap items-center gap-12 px-5 pb-20 pt-12 sm:px-8 sm:pt-16">
        <div className="min-w-0 flex-[999_1_480px]">
          <span className="inline-flex rounded-full bg-sun px-3 py-1.5 text-[13px] font-semibold text-sun-ink">Adult work welcome. Clearly labelled, never hidden away.</span>
          <h1 className="mt-5 text-[clamp(3.2rem,9vw,7.5rem)] font-extrabold leading-[0.9] tracking-[-0.05em]">
            Your comic.<br /><span className="text-accent">Your rules.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted sm:text-xl">
            {settings.site.name} is a home for creator-owned comics, including the ones other platforms take down. Publish free, keep your rights, and get paid by what people actually read.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton to={publish} variant="primary" size="lg">Start publishing free</LinkButton>
            <LinkButton to="/browse" variant="secondary" size="lg">Browse the store</LinkButton>
          </div>
        </div>
        <div aria-hidden className="relative flex min-w-0 flex-[1_1_300px] justify-center">
          <Dots className="-right-16 -top-10 size-[380px]" />
          <div className="relative h-[520px] w-[260px] rotate-[4deg] rounded-[40px] border-2 border-line-strong bg-surface p-3">
            <div className="grid h-full grid-rows-[1.2fr_1fr_1fr] gap-2 rounded-[28px] bg-paper p-3">
              <div className="rounded bg-ink" />
              <div className="grid grid-cols-[1.3fr_1fr] gap-2">
                <div className="rounded bg-accent outline outline-4 outline-offset-2 outline-ink" />
                <div className="rounded bg-ink/25" />
              </div>
              <div className="grid grid-cols-[1fr_1.6fr] gap-2">
                <div className="rounded bg-ink/25" />
                <div className="rounded bg-ink/25" />
              </div>
            </div>
          </div>
          <div className="absolute bottom-20 left-[2%] h-10 w-52 -rotate-[14deg] bg-sun" />
        </div>
      </section>

      {/* Four pillars */}
      <section className="bg-paper text-ink">
        <div className="mx-auto grid max-w-6xl gap-7 px-5 py-11 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
          {[
            ['Adult-friendly', 'Explicit work for adults is allowed here and has a proper place in the store, behind an age check.'],
            ['Creator-owned', 'You keep the copyright. Publishing here is non-exclusive, and you can take your work and your files with you.'],
            ['Paid by reading', "A member's fee goes to the creators that member read. Sell issues directly too, and keep most of every sale."],
            ['Made by people', 'No AI-generated comics, and your pages are not fed to a model.'],
          ].map(([t, d]) => (
            <div key={t}>
              <div className="font-display text-2xl font-extrabold tracking-tight">{t}</div>
              <p className="mt-2 text-[15px] leading-relaxed text-ink/75">{d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Promise */}
      <section className="mx-auto flex max-w-6xl flex-wrap gap-12 px-5 py-20 sm:px-8 sm:py-24">
        <div className="min-w-0 flex-[1_1_340px]">
          <Eyebrow>The creator promise</Eyebrow>
          <h2 className="mt-3 text-[clamp(2.2rem,5vw,3.8rem)] font-extrabold leading-[0.95] tracking-[-0.04em]">No email on Monday saying your books are gone on Tuesday.</h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">Rules are written down in plain words, they apply to everyone, and they do not change under your feet.</p>
          <Link to="/p/creator-promise" className="mt-5 inline-flex items-center gap-1.5 font-semibold text-accent-hover hover:text-paper">Read the full promise <ArrowRight className="size-4" /></Link>
        </div>
        <ol className="flex min-w-0 flex-[1.3_1_420px] flex-col gap-3.5">
          {PROMISES.map(([t, d], i) => (
            <li key={t} className="flex gap-4 rounded-2xl border border-line bg-surface p-5">
              <span className="font-display text-3xl font-extrabold leading-none text-accent">{i + 1}</span>
              <div>
                <div className="text-lg font-semibold">{t}</div>
                <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Frames */}
      <section className="bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-12 px-5 py-20 sm:px-8 sm:py-24">
          <div aria-hidden className="flex min-w-0 flex-[1_1_360px] items-center justify-center gap-5">
            <div className="grid h-[280px] w-[196px] grid-rows-[1.1fr_1fr_1fr] gap-2 rounded-lg bg-paper p-3">
              <div className="rounded bg-accent" />
              <div className="grid grid-cols-2 gap-2"><div className="rounded bg-ink" /><div className="rounded bg-ink" /></div>
              <div className="rounded bg-ink" />
            </div>
            <ArrowRight className="size-10 shrink-0 text-sun" strokeWidth={2.5} />
            <div className="h-[280px] w-[140px] rounded-[24px] border-2 border-line-strong bg-ink p-2.5"><div className="h-full rounded-2xl bg-accent" /></div>
          </div>
          <div className="min-w-0 flex-[1_1_380px]">
            <Eyebrow tone="sun">Reads right on every screen</Eyebrow>
            <h2 className="mt-3 text-[clamp(2.2rem,5vw,3.8rem)] font-extrabold leading-[0.95] tracking-[-0.04em]">One frame at a time, the way you paced it.</h2>
            <p className="mt-5 text-lg leading-relaxed text-muted">
              A print page is unreadable on a phone. Here the reader moves frame by frame, each one filling the screen. Set frames by hand, or detect them for a whole issue in one click and fix the few that need it.
            </p>
          </div>
        </div>
      </section>

      {/* Money */}
      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <Eyebrow>How you get paid</Eyebrow>
        <h2 className="mt-3 max-w-3xl text-[clamp(2.2rem,5vw,3.8rem)] font-extrabold leading-[0.95] tracking-[-0.04em]">Free to publish. No paid tier to unlock a better cut.</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <div className="rounded-3xl bg-accent p-7 text-accent-ink">
            <div className="font-display text-7xl font-extrabold leading-[0.9] tracking-[-0.05em] sm:text-[5.5rem]">{pct(r.sale_share_bps)}%</div>
            <div className="mt-3 text-lg font-semibold">of every direct sale</div>
            <p className="mt-1.5 text-[15px] leading-relaxed">Issues, volumes, bundles and downloads, after card fees.</p>
          </div>
          <div className="rounded-3xl border border-line bg-surface p-7">
            <div className="font-display text-7xl font-extrabold leading-[0.9] tracking-[-0.05em] sm:text-[5.5rem]">{pct(r.sub_share_bps)}%</div>
            <div className="mt-3 text-lg font-semibold">of membership money</div>
            <p className="mt-1.5 text-[15px] leading-relaxed text-muted">Each member's fee is split among the creators that member read that month, by pages.</p>
          </div>
          <div className="rounded-3xl border border-line bg-surface p-7">
            <div className="font-display text-7xl font-extrabold leading-[0.9] tracking-[-0.05em] sm:text-[5.5rem]">{pct(r.tip_share_bps)}%</div>
            <div className="mt-3 text-lg font-semibold">of tips</div>
            <p className="mt-1.5 text-[15px] leading-relaxed text-muted">Readers can tip a creator directly from the brand page.</p>
          </div>
        </div>
        <p className="mt-6 max-w-3xl text-[15px] leading-relaxed text-muted">
          Running a crowdfunding campaign? Hand backers a code per reward tier and they read their copy here, with your campaign banner on every page of the series.
        </p>
      </section>

      {/* Edges */}
      <section className="bg-paper text-ink">
        <div className="mx-auto flex max-w-6xl flex-wrap gap-10 px-5 py-16 sm:px-8 sm:py-20">
          <div className="min-w-0 flex-[1_1_300px]">
            <h2 className="text-[clamp(1.9rem,4vw,3rem)] font-extrabold leading-none tracking-[-0.04em]">Freedom has edges. Here they are.</h2>
            <p className="mt-4 text-[17px] leading-relaxed text-ink/75">A short list, stated up front, so nobody has to guess.</p>
            <Link to="/p/content-policy" className="mt-4 inline-flex items-center gap-1.5 font-semibold underline underline-offset-4">Content policy <ArrowRight className="size-4" /></Link>
          </div>
          <ul className="grid min-w-0 flex-[1.4_1_380px] gap-x-7 gap-y-4 sm:grid-cols-2">
            {EDGES.map(([t, d]) => (
              <li key={t} className="border-t-[3px] border-ink pt-3.5 leading-snug"><strong>{t}</strong> {d}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* Closing */}
      <section className="mx-auto max-w-6xl px-5 py-24 text-center sm:px-8">
        <h2 className="mx-auto max-w-4xl text-[clamp(2.6rem,7vw,5.5rem)] font-extrabold leading-[0.92] tracking-[-0.05em]">Bring the books they would not carry.</h2>
        <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted">Upload a PDF or a folder of pages and have your first issue readable on a phone the same day.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <LinkButton to={publish} variant="primary" size="lg">Start publishing free</LinkButton>
          <LinkButton to="/browse" variant="secondary" size="lg">Read something</LinkButton>
        </div>
      </section>
    </div>
  );
}
