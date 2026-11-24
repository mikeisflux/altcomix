import { Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Field, IconButton, Input, Select } from '@/ui';
import type { Contributor } from './SeriesEditor';
import { useAct } from './shared';
import type { QueryKey } from '@tanstack/react-query';

/**
 * Credits for a whole series (`releaseId` null) or for one release.
 * Each change is saved straight away.
 */
export function ContributorsEditor({ seriesId, releaseId, contributors, invalidate, canEdit }: { seriesId: string; releaseId: string | null; contributors: Contributor[]; invalidate: QueryKey[]; canEdit: boolean }) {
  const { meta } = useSession();
  const [name, setName] = useState('');
  const [role, setRole] = useState(meta.contributorRoles[0] ?? 'Writer');
  const [username, setUsername] = useState('');
  const add = useAct(
    () => api(`/api/studio/series/${seriesId}/contributors`, { json: { name, role, username: username.replace(/^@/, '') || null, release_id: releaseId } }),
    { success: 'Contributor added', invalidate, onDone: () => { setName(''); setUsername(''); } },
  );
  const remove = useAct((id: string) => api(`/api/studio/series/${seriesId}/contributors/${id}`, { method: 'DELETE' }), { success: 'Contributor removed', invalidate });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    add.mutate();
  };
  return (
    <div className="space-y-3">
      {contributors.length === 0 ? (
        <p className="text-sm text-muted">{releaseId ? 'No credits specific to this release. Series credits still apply.' : 'Nobody is credited yet.'}</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {contributors.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate"><span className="font-medium">{c.name}</span>{c.username && <span className="text-muted"> @{c.username}</span>}</span>
              <span className="text-muted">{c.role}</span>
              {canEdit && <IconButton label={`Remove ${c.name}`} disabled={remove.isPending} onClick={() => remove.mutate(c.id)}><Trash2 className="size-4" /></IconButton>}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-[1fr_150px_150px_auto]">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></Field>
          <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{meta.contributorRoles.map((r) => <option key={r}>{r}</option>)}</Select></Field>
          <Field label="NSFWComix username" optional><Input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={24} placeholder="@name" /></Field>
          <Button type="submit" loading={add.isPending} icon={<UserPlus className="size-4" />}>Add</Button>
        </form>
      )}
    </div>
  );
}
