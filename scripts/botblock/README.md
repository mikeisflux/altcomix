# BotBlock firewall scripts

Kernel-level blocking for the IPs the NSFWComix bot blocker catches. Ported from
IndieCrowdfund's `botblock-firewall` and adapted to this schema.

The API already answers blocked IPs with a 403. These scripts go one step
further and drop their packets in iptables, so a scanner hammering the site
costs no CPU in nginx or Node at all.

## How it fits together

```
API (api/src/lib/botblock.ts)            Admin > Security > Blocked IPs
  blocks an IP                              block / unblock
        |                                        |
        v                                        v
  blocked_ips table  <-------------------------- +
  /tmp/botblock-pending   (one IP per line)      /tmp/botblock-unblock (one IP per line)
        |                                        |
        +-------------------+--------------------+
                            v
        botblock-watcher (systemd, root, every 5 s)
            adds / removes DROP rules in chain BOTBLOCK
                            ^
        botblock-sync (cron, root, every 5 min)
            reconciles the chain with blocked_ips:
            adds what is missing, removes what expired or was unblocked
```

- **Watcher** is the fast path: a new block reaches the firewall within about
  five seconds. On start it restores every active block from the database, so
  rules survive a reboot.
- **Sync** is the safety net. It makes the chain match the `blocked_ips` table,
  including removing rules whose block expired, and deletes rows that expired
  more than seven days ago. If it cannot reach the database it changes nothing.
- Signed-in users are never blocked by the API, but the firewall cannot tell
  who is signed in: once a rule exists, that address cannot reach the site.
  Unblock from the admin panel if a real person is caught.

## Files

| File | Installed as | Purpose |
|---|---|---|
| `botblock-lib.sh` | `/usr/local/lib/botblock/botblock-lib.sh` | Shared functions (validation, iptables, database) |
| `botblock-watcher.sh` | `/usr/local/lib/botblock/botblock-watcher.sh` | The 5-second loop |
| `sync-blocked-ips.sh` | `/usr/local/lib/botblock/sync-blocked-ips.sh` (+ `/usr/local/bin/botblock-sync`) | Reconciliation, run from cron |
| `botblock-manual.sh` | `/usr/local/lib/botblock/botblock-manual.sh` (+ `/usr/local/bin/botblock-manual`) | Look at / change the chain by hand |
| `botblock-watcher.service` | `/etc/systemd/system/botblock-watcher.service` | systemd unit |
| `botblock.env.example` | `/etc/default/botblock-watcher` (filled in on the server) | Database connection settings |

## Install

Requirements: Linux with `iptables` (and `ip6tables` if the server has IPv6),
`psql` (package `postgresql-client`), bash 4+, root access.

All commands from the repository root on the server.

```bash
# 1. Scripts (the three scripts must stay in the same directory as botblock-lib.sh)
sudo install -d -m 755 /usr/local/lib/botblock
sudo install -m 755 scripts/botblock/botblock-lib.sh scripts/botblock/botblock-watcher.sh \
     scripts/botblock/sync-blocked-ips.sh scripts/botblock/botblock-manual.sh /usr/local/lib/botblock/
sudo ln -sf /usr/local/lib/botblock/sync-blocked-ips.sh /usr/local/bin/botblock-sync
sudo ln -sf /usr/local/lib/botblock/botblock-manual.sh /usr/local/bin/botblock-manual

# 2. Database settings: a root-only file that is never committed
sudo install -m 600 -o root -g root scripts/botblock/botblock.env.example /etc/default/botblock-watcher
sudo nano /etc/default/botblock-watcher
```

The scripts only need to read `blocked_ips` and delete old rows from it. A
dedicated database role is better than reusing the application's:

```sql
create role botblock login password '...';
grant select, delete on blocked_ips to botblock;
```

For the password, either set `DB_PASS=` in `/etc/default/botblock-watcher`, or
leave it out and add a line to `/root/.pgpass` (mode 600):

```
127.0.0.1:5432:nsfwcomix:botblock:the-password
```

```bash
# 3. Check the connection and do a first sync by hand
sudo botblock-sync && sudo botblock-manual count

# 4. Watcher service
sudo cp scripts/botblock/botblock-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now botblock-watcher
sudo systemctl status botblock-watcher
tail /var/log/botblock-watcher.log

# 5. Sync cron (root's crontab)
sudo crontab -e
#   */5 * * * * /usr/local/bin/botblock-sync >> /var/log/botblock.log 2>&1
```

After updating the repository, repeat step 1 and `sudo systemctl restart botblock-watcher`.

## Settings

All optional, set in `/etc/default/botblock-watcher` as plain `KEY=value` lines.

| Variable | Default | |
|---|---|---|
| `DB_HOST` | `127.0.0.1` | |
| `DB_PORT` | `5432` | |
| `DB_NAME` | `nsfwcomix` | |
| `DB_USER` | `nsfwcomix` | |
| `DB_PASS` | (none) | If absent, `~/.pgpass` of the user running the script is used |
| `BOTBLOCK_ALLOWLIST` | (none) | Space-separated addresses that are never dropped |
| `BOTBLOCK_INTERVAL` | `5` | Seconds between watcher passes |
| `BOTBLOCK_CHAIN` | `BOTBLOCK` | iptables chain name |

## Everyday use

```bash
sudo botblock-manual list            # every address in the chain
sudo botblock-manual count
sudo botblock-manual unblock 203.0.113.9
sudo botblock-manual block 203.0.113.9
sudo botblock-manual flush           # empty the chain (the next sync refills it from the database)
tail -f /var/log/botblock-watcher.log /var/log/botblock.log
```

`botblock-manual` only touches iptables. A block made with it is not in the
database, so the next sync removes it; an unblock comes back if the block is
still active in the database. For anything meant to last, use **Admin >
Security > Blocked IPs**: it records the reason, writes an audit entry, and the
firewall follows within seconds.

**Locked yourself out?** From the server console:

```bash
sudo botblock-manual unblock YOUR.IP.ADDRESS
psql nsfwcomix -c "delete from blocked_ips where ip_address = 'YOUR.IP.ADDRESS'"
```

Then add your address to `BOTBLOCK_ALLOWLIST`.

## Safety rules built in

- Every line read from the files in `/tmp` must be a well-formed IPv4 or IPv6
  address or it is skipped and logged. Nothing from those files is ever
  evaluated by the shell.
- Loopback, private (10/8, 172.16/12, 192.168/16), link-local and allowlisted
  addresses are never dropped, whatever asked for it.
- The queue files must be regular files; a symlink is ignored.
- Rules live in their own chain, so `botblock-manual flush` or removing the
  jump from `INPUT` undoes everything without touching your other firewall rules.

## Things to know

- **Behind Cloudflare or another proxy**, packets arrive from the proxy's
  addresses, so an iptables rule for the visitor's address never matches. The
  API-level block still works (given the `real_ip` setup described in
  `scripts/deploy/nginx.conf`). You can skip installing these scripts in that
  setup, or use the proxy's own firewall.
- **`/tmp/botblock-pending` is shared by contract** with `api/src/lib/botblock.ts`.
  Any local user can write to `/tmp`, so on a shared machine another account
  could queue a block. On a single-purpose server this is not a concern; the
  validation and the protected ranges above limit the damage either way.
- **Rules are not persisted by iptables itself.** After a reboot the chain is
  rebuilt by the watcher from the database, which is why the unit starts after
  PostgreSQL.
- **IPv6** rules are compared as text with what `ip6tables` prints. Addresses
  are stored the way Node reports them (compressed, lower case), which matches.
- **nftables-based systems** work through the `iptables-nft` compatibility
  commands that Debian and Ubuntu install by default.

## Uninstall

```bash
sudo systemctl disable --now botblock-watcher
sudo rm /etc/systemd/system/botblock-watcher.service /usr/local/bin/botblock-sync /usr/local/bin/botblock-manual
sudo rm -r /usr/local/lib/botblock /etc/default/botblock-watcher
sudo iptables -D INPUT -j BOTBLOCK; sudo iptables -F BOTBLOCK; sudo iptables -X BOTBLOCK
sudo ip6tables -D INPUT -j BOTBLOCK; sudo ip6tables -F BOTBLOCK; sudo ip6tables -X BOTBLOCK
# and remove the botblock-sync line from root's crontab
```

## How these were checked

There is no way to change a real firewall from the development sandbox, so the
scripts were run against a stand-in `iptables`/`ip6tables` that records rules
in a file, with the real `blocked_ips` table. Covered: startup restore, pending
and unblock queues, rejection of malformed and shell-injection lines, protected
and allowlisted addresses, reconciliation in both directions, the 7-day
clean-up, and the "database unreachable, change nothing" path. They have not
yet been run against a live kernel firewall; do step 3 above and check
`sudo iptables -S BOTBLOCK` after the first real block.
