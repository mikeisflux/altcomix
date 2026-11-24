import { BadgeDollarSign, BookOpenCheck, Frame, Ticket, UsersRound } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, FormRow, Input, LinkButton, Modal, Notice, PageHeader, PageLoader, Segmented, Textarea } from '@/ui';
import { errorMessage } from '@/lib/api';
import { Q, SignInNeeded, useAct, useBrands, useTitle, Group } from './shared';
import type { StudioBrand } from './shared';

function Pitch() {
  const { settings } = useSession();
  useTitle('Publish your comics');
  const points = [
    { icon: <BadgeDollarSign />, title: 'Free to publish', body: 'There is no paid plan and nothing to unlock. You keep most of every sale, tip and membership read, and each series shows you the exact percentages before you publish.' },
    { icon: <Frame />, title: 'Frames in one click', body: 'Upload a PDF, a CBZ or loose images. One button finds the panels on every page so your comic reads frame by frame on a phone. It is classical image analysis, not generative AI, and you can correct any page by hand.' },
    { icon: <Ticket />, title: 'Backer codes', body: 'Ran a crowdfunding campaign? Import your backer list, generate one code per backer for each reward tier and email them from here.' },
    { icon: <BookOpenCheck />, title: 'You set the paywall', body: `Make a series free, sell releases one by one, or include it in ${settings.membership.name}. Choose how much readers can preview before they pay.` },
    { icon: <UsersRound />, title: 'Bring your team', body: 'Invite editors, analysts and co-owners. Split a series\' earnings with collaborators and each is paid into their own balance.' },
  ];
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Publish your comics on AltComix" description="A studio for creators and publishers: upload, set your terms, publish. Readers get a guided, frame-by-frame view on any screen." />
      <div className="mb-8 flex flex-wrap gap-2">
        <LinkButton to="/register?next=%2Fstudio" variant="primary" size="lg">Create a free account</LinkButton>
        <LinkButton to="/login?next=%2Fstudio" size="lg">Sign in</LinkButton>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {points.map((p) => (
          <Card key={p.title} className="p-5">
            <div className="mb-3 text-accent-hover [&>svg]:size-6">{p.icon}</div>
            <h2 className="text-lg font-semibold">{p.title}</h2>
            <p className="mt-1.5 text-sm text-muted">{p.body}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

function slugify(name: string) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function CreateBrandForm({ onDone }: { onDone: (b: StudioBrand) => void }) {
  const { refresh } = useSession();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [bio, setBio] = useState('');
  const [kind, setKind] = useState<'creator' | 'publisher'>('creator');
  const [error, setError] = useState<string | null>(null);
  const create = useAct(
    () => api<{ brand: StudioBrand }>('/api/studio/brands', { json: { name, slug: (slug ?? slugify(name)) || undefined, bio, kind } }),
    { success: 'Brand created', invalidate: [['studio', 'brands']], onDone: async (r) => { await refresh(); onDone(r.brand); } },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate(undefined, { onError: (err) => setError(errorMessage(err)) });
  };
  const shownSlug = slug ?? slugify(name);
  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <ErrorState message={error} />}
      <Field label="Brand name" hint="Your pen name, studio or imprint. Readers see this on every series.">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} />
      </Field>
      <Field label="Brand address" hint={`Your public page will be at /${shownSlug || 'your-brand'}. Lowercase letters, numbers and dashes.`}>
        <Input value={shownSlug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} minLength={3} maxLength={60} />
      </Field>
      <Field label="Short bio" optional><Textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={400} className="min-h-20" /></Field>
      <Group label="I am publishing as" hint={kind === 'publisher' ? 'Publisher status is confirmed by our team. Until then the brand shows as a creator; nothing else changes.' : 'An individual creator or a creative team.'}>
        <Segmented value={kind} onChange={setKind} options={[{ value: 'creator', label: 'A creator' }, { value: 'publisher', label: 'A publisher' }]} />
      </Group>
      <Button type="submit" variant="primary" loading={create.isPending}>Create brand</Button>
    </form>
  );
}

function BrandList({ brands }: { brands: StudioBrand[] }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  useTitle('Your brands');
  if (brands.length === 0) {
    return (
      <div className="mx-auto max-w-xl">
        <PageHeader title="Start publishing" description="A brand is the name your comics are published under. It takes a minute, costs nothing, and you can change everything later." />
        <Card className="p-5"><CreateBrandForm onDone={(b) => nav(`/studio/${b.slug}`)} /></Card>
      </div>
    );
  }
  return (
    <div>
      <PageHeader title="Your brands" description="Choose the brand you want to work on." actions={<Button onClick={() => setOpen(true)}>New brand</Button>} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {brands.map((b) => (
          <Link key={b.id} to={`/studio/${b.slug}`} className="flex items-center gap-3.5 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-raised">
            <Avatar src={b.avatar_url} name={b.name} size={52} square />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><span className="truncate font-semibold">{b.name}</span>{b.suspended && <Badge tone="danger">Suspended</Badge>}</div>
              <div className="text-sm text-muted">{b.series_count} series · {b.member_count} {b.member_count === 1 ? 'member' : 'members'}</div>
              <div className="mt-1"><Badge>{b.role}</Badge></div>
            </div>
          </Link>
        ))}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="New brand"><CreateBrandForm onDone={(b) => { setOpen(false); nav(`/studio/${b.slug}`); }} /></Modal>
    </div>
  );
}

export function StudioHome() {
  const { user } = useSession();
  const brands = useBrands(Boolean(user));
  if (!user) return <Pitch />;
  return <Q query={brands}>{(d) => <BrandList brands={d.brands} />}</Q>;
}

type Invite = { brand: { id: string; name: string; slug: string; avatar_url: string | null }; role: string; email: string; expires_at: string; for_you: boolean };

export function AcceptInvite() {
  const { user, refresh } = useSession();
  const params = useParams();
  const [search] = useSearchParams();
  const token = params.token ?? search.get('token') ?? '';
  const nav = useNavigate();
  useTitle('Team invitation');
  const invite = useQuery({ queryKey: ['studio', 'invite', token], queryFn: () => api<{ invite: Invite }>(`/api/studio/invites/${encodeURIComponent(token)}`), enabled: Boolean(user && token), retry: false });
  const accept = useAct(() => api<{ brand: { slug: string; name: string } }>('/api/studio/invites/accept', { json: { token } }), {
    success: (r) => `You are now part of ${r.brand.name}`,
    invalidate: [['studio', 'brands']],
    onDone: async (r) => { await refresh(); nav(`/studio/${r.brand.slug}`); },
  });
  if (!user) return <SignInNeeded what="your invitation" />;
  if (!token) return <EmptyState title="This invitation link is incomplete" action={<LinkButton to="/studio">Go to the Studio</LinkButton>}>Open the link from your invitation email again.</EmptyState>;
  if (invite.isLoading) return <PageLoader />;
  if (invite.isError) return <EmptyState title="This invitation is no longer valid" action={<LinkButton to="/studio">Go to the Studio</LinkButton>}>It may have expired, been withdrawn, or already been accepted. Ask the brand to send a new one.</EmptyState>;
  const inv = invite.data!.invite;
  return (
    <div className="mx-auto max-w-md">
      <Card className="space-y-4 p-6 text-center">
        <div className="flex justify-center"><Avatar src={inv.brand.avatar_url} name={inv.brand.name} size={64} square /></div>
        <h1 className="text-2xl font-bold">Join {inv.brand.name}</h1>
        <p className="text-sm text-muted">You have been invited as <strong className="text-paper">{inv.role}</strong>. The invitation was sent to {inv.email}.</p>
        {!inv.for_you && <Notice tone="warn">You are signed in as {user.email}. Sign in with the invited address to accept.</Notice>}
        <FormRow>
          <LinkButton to="/studio" block>Not now</LinkButton>
          <Button variant="primary" block disabled={!inv.for_you} loading={accept.isPending} onClick={() => accept.mutate()}>Accept invitation</Button>
        </FormRow>
      </Card>
    </div>
  );
}
