import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileText, Newspaper } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage } from '@/lib/api';
import { date } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import { EmptyState, ErrorState, LinkButton, PageLoader, Pagination, Skeleton } from '@/ui';
import { useTitle } from './shared';

type CmsPage = { slug: string; title: string; body: string; updated_at: string };
type PostSummary = { slug: string; title: string; excerpt: string | null; cover_url: string | null; published_at: string };
type Post = PostSummary & { body: string; author_name: string | null };

const is404 = (e: unknown) => e instanceof ApiError && e.status === 404;

/** Footer pages written in /admin (About, Terms, Privacy ...). */
export function CmsPageView() {
  const { slug = '' } = useParams();
  const q = useQuery({ queryKey: ['cms', slug], queryFn: () => api<{ page: CmsPage }>(`/api/pages/${encodeURIComponent(slug)}`), retry: false });
  useTitle(q.data?.page.title ?? (q.isError ? 'Page not found' : null));
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) {
    if (is404(q.error)) {
      return (
        <div className="mx-auto max-w-xl py-10">
          <EmptyState icon={<FileText />} title="Page not found" action={<LinkButton to="/" variant="primary">Go to the store</LinkButton>}>The link may be old, or the page may have moved.</EmptyState>
        </div>
      );
    }
    return <ErrorState message={errorMessage(q.error)} retry={() => void q.refetch()} />;
  }
  const { page } = q.data;
  return (
    <article className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-extrabold sm:text-4xl">{page.title}</h1>
      <p className="mb-8 mt-2 text-sm text-faint">Last updated {date(page.updated_at)}</p>
      {page.body.trim() ? <Markdown source={page.body} /> : <p className="text-muted">This page has not been written yet.</p>}
    </article>
  );
}

export function NewsList() {
  useTitle('News');
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const q = useQuery({
    queryKey: ['news', page],
    queryFn: () => api<{ posts: PostSummary[]; total: number; page: number; limit: number }>('/api/news', { query: { page } }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold sm:text-3xl">News</h1>
        <p className="mt-1.5 text-muted">Announcements, new features and creator spotlights from the team.</p>
      </header>
      {q.isLoading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-64" />)}</div>
      ) : q.isError || !q.data ? (
        <ErrorState message={errorMessage(q.error)} retry={() => void q.refetch()} />
      ) : q.data.posts.length === 0 ? (
        <EmptyState icon={<Newspaper />} title="No news yet" action={<LinkButton to="/browse">Browse comics instead</LinkButton>}>When the team posts an update, it shows up here.</EmptyState>
      ) : (
        <>
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {q.data.posts.map((p) => (
              <li key={p.slug}>
                <Link to={`/news/${p.slug}`} className="group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-line-strong">
                  <div className="aspect-[16/9] w-full overflow-hidden bg-raised">
                    {p.cover_url ? <img src={p.cover_url} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" /> : <div className="flex size-full items-center justify-center text-faint"><Newspaper className="size-8" aria-hidden /></div>}
                  </div>
                  <div className="flex flex-1 flex-col p-4">
                    <time dateTime={p.published_at} className="text-xs text-faint">{date(p.published_at)}</time>
                    <h2 className="mt-1 text-lg font-semibold leading-snug group-hover:text-accent-hover">{p.title}</h2>
                    {p.excerpt && <p className="mt-1.5 line-clamp-3 text-sm text-muted">{p.excerpt}</p>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination page={q.data.page} pages={Math.ceil(q.data.total / q.data.limit)} onPage={(p) => { setParams(p > 1 ? { page: String(p) } : {}); window.scrollTo({ top: 0 }); }} />
        </>
      )}
    </div>
  );
}

export function NewsPost() {
  const { slug = '' } = useParams();
  const q = useQuery({ queryKey: ['news-post', slug], queryFn: () => api<{ post: Post }>(`/api/news/${encodeURIComponent(slug)}`), retry: false });
  useTitle(q.data?.post.title ?? (q.isError ? 'News' : null));
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) {
    if (is404(q.error)) {
      return (
        <div className="mx-auto max-w-xl py-10">
          <EmptyState icon={<Newspaper />} title="That post is not here" action={<LinkButton to="/news" variant="primary">All news</LinkButton>}>It may have been unpublished, or the link may be wrong.</EmptyState>
        </div>
      );
    }
    return <ErrorState message={errorMessage(q.error)} retry={() => void q.refetch()} />;
  }
  const { post } = q.data;
  return (
    <article className="mx-auto max-w-3xl">
      <Link to="/news" className="mb-4 inline-flex h-10 items-center gap-1.5 text-sm text-muted hover:text-paper"><ArrowLeft className="size-4" aria-hidden />All news</Link>
      <h1 className="text-3xl font-extrabold sm:text-4xl">{post.title}</h1>
      <p className="mt-2 text-sm text-faint">
        <time dateTime={post.published_at}>{date(post.published_at)}</time>{post.author_name ? ` · ${post.author_name}` : ''}
      </p>
      {post.cover_url && <img src={post.cover_url} alt="" className="mt-6 aspect-[16/9] w-full rounded-2xl border border-line object-cover" />}
      <div className="mt-8"><Markdown source={post.body} /></div>
    </article>
  );
}
