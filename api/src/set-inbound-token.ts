import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { pool } from './db.ts';
import { setSetting } from './lib/settings.ts';

/**
 * Set the inbound mail secret from the server shell: the last part of the
 * address the mail provider posts incoming mail to. Stored encrypted, exactly
 * as when it is saved in Admin > Settings > Email.
 *
 *   node --env-file=../.env src/set-inbound-token.ts <token>     use this secret (32+ letters, digits, - or _)
 *   node --env-file=../.env src/set-inbound-token.ts --generate  make a new random one and print the address
 *
 * Use it when the address has already been given to the provider, or before
 * anyone has signed in to the admin panel. Running API workers pick the new
 * value up within 15 seconds. Setting a new secret stops the old address working.
 */
const [arg] = process.argv.slice(2);

async function main(): Promise<number> {
  const token = arg === '--generate' ? randomBytes(32).toString('base64url') : (arg ?? '').trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    console.error('Usage: node --env-file=../.env src/set-inbound-token.ts <token | --generate>');
    console.error('The secret must be at least 32 characters, using only letters, digits, - and _.');
    return 2;
  }
  await setSetting('email', { inbound_token: token }, null);
  await pool.query(`insert into audit_log (actor_id, action, target_kind, target_id, meta, ip) values (null, 'settings.update', 'settings', 'email', $1, 'cli')`, [
    JSON.stringify({ diff: { inbound_token: 'secret set' }, via: 'set-inbound-token.ts' }),
  ]);
  console.log('Inbound mail secret saved.');
  if (arg === '--generate') console.log(`  Address to give the mail provider: ${config.appUrl}/api/webhooks/email/inbound/${token}`);
  else console.log(`  Address to give the mail provider: ${config.appUrl}/api/webhooks/email/inbound/<the secret you passed in>`);
  return 0;
}

const code = await main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  return 1;
});
await pool.end();
process.exit(code);
