import { randomBytes } from 'node:crypto';
import { exec, one, pool } from './db.ts';
import { hashPassword } from './lib/crypto.ts';

/**
 * Create a super admin account from the server shell, or reset an existing
 * one: sets the password, confirms the email and makes it a super admin.
 *
 *   node --env-file=../.env src/create-admin.ts <email>              random password, printed once
 *   node --env-file=../.env src/create-admin.ts <email> <password>   use this password
 *
 * Use it for the very first account on a new server, or to get back in when
 * the only admin is locked out. Existing sessions for the account are ended.
 * Change the password after signing in if it was typed on a shared terminal.
 */
const [emailArg, passwordArg] = process.argv.slice(2);

async function main(): Promise<number> {
  const email = (emailArg ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage: node --env-file=../.env src/create-admin.ts <email> [password]');
    return 2;
  }
  const password = passwordArg ?? randomBytes(18).toString('base64url');
  if (password.length < 10) {
    console.error('The password must be at least 10 characters.');
    return 2;
  }
  const hash = await hashPassword(password);

  const existing = await one<{ id: string; username: string }>('select id, username from users where lower(email) = $1', [email]);
  let id: string;
  let username: string;
  if (existing) {
    id = existing.id;
    username = existing.username;
    await exec(
      `update users set password_hash = $2, role = 'super_admin', email_verified_at = coalesce(email_verified_at, now()),
              failed_logins = 0, locked_until = null, banned_at = null, ban_reason = null, deleted_at = null
        where id = $1`,
      [id, hash],
    );
    await exec('delete from sessions where user_id = $1', [id]);
  } else {
    // A unique username from the part before the @.
    const base = (email.split('@')[0].replace(/[^A-Za-z0-9_]/g, '').slice(0, 20) || 'admin').padEnd(3, '_');
    username = base;
    for (let n = 2; await one('select 1 from users where lower(username) = lower($1)', [username]); n++) username = `${base.slice(0, 20)}${n}`;
    const prefs = { notify: { releases: true, messages: true, replies: true, mentions: true, followers: true, feed: true, analytics: true, newsletter: false } };
    const row = await one<{ id: string }>(
      `insert into users (email, username, display_name, password_hash, role, email_verified_at, prefs)
       values ($1,$2,$2,$3,'super_admin', now(), $4) returning id`,
      [email, username, hash, JSON.stringify(prefs)],
    );
    id = row!.id;
  }
  await exec(`insert into audit_log (actor_id, action, target_kind, target_id, meta, ip) values (null, 'user.role', 'user', $1, $2, 'cli')`, [
    id,
    JSON.stringify({ email, to: 'super_admin', created: !existing, password_set: true, via: 'create-admin.ts' }),
  ]);

  console.log(existing ? 'Existing account updated.' : 'Account created.');
  console.log(`  Email:    ${email}`);
  console.log(`  Username: ${username}`);
  console.log(`  Password: ${passwordArg ? '(the one you passed in)' : password}`);
  console.log('  Role:     super admin, email confirmed');
  return 0;
}

const code = await main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  return 1;
});
await pool.end();
process.exit(code);
