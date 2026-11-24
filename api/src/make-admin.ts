import { one, pool } from './db.ts';

/**
 * Promote an existing account from the server shell.
 *
 *   node src/make-admin.ts <email>            -> super_admin
 *   node src/make-admin.ts <email> admin      -> admin
 *   node src/make-admin.ts <email> user       -> remove staff access
 *
 * The first super admin is normally created by registering with the address
 * in SUPER_ADMIN_EMAIL; this is for everything after that.
 */
const [email, role = 'super_admin'] = process.argv.slice(2);

async function main(): Promise<number> {
  if (!email || !['super_admin', 'admin', 'user'].includes(role)) {
    console.error('Usage: node src/make-admin.ts <email> [super_admin|admin|user]');
    return 2;
  }
  const user = await one<{ id: string; role: string; deleted_at: string | null; banned_at: string | null }>(
    'select id, role, deleted_at, banned_at from users where lower(email) = lower($1)', [email]);
  if (!user) {
    console.error(`No account with the email ${email}. Register it on the site first.`);
    return 1;
  }
  if (user.deleted_at || user.banned_at) {
    console.error('That account is deleted or banned; refusing to give it staff access.');
    return 1;
  }
  if (user.role === 'super_admin' && role !== 'super_admin') {
    const others = await one<{ n: number }>(`select count(*)::int as n from users where role = 'super_admin' and deleted_at is null and id <> $1`, [user.id]);
    if (!others?.n) {
      console.error('That is the last super admin. Promote someone else first.');
      return 1;
    }
  }
  await one('update users set role = $2 where id = $1 returning id', [user.id, role]);
  await one(
    `insert into audit_log (actor_id, action, target_kind, target_id, meta, ip) values (null, 'user.role', 'user', $1, $2, 'cli') returning id`,
    [user.id, JSON.stringify({ email: email.toLowerCase(), from: user.role, to: role, via: 'make-admin.ts' })],
  );
  console.log(`${email}: ${user.role} -> ${role}`);
  return 0;
}

const code = await main().catch((e) => {
  console.error((e as Error).message);
  return 1;
});
await pool.end();
process.exit(code);
