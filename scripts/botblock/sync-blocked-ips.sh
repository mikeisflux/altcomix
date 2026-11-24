#!/bin/bash
# ============================================================================
# sync-blocked-ips.sh
#
# Full reconciliation between the blocked_ips table and the BOTBLOCK iptables
# chain. The watcher handles the instant path; this is the safety net:
#
#   - applies anything waiting in /tmp/botblock-unblock (admin unblocks)
#   - adds a DROP rule for every active block that has none
#   - removes rules whose block has expired or was deleted in /admin
#   - deletes rows that expired more than 7 days ago
#
# If the database cannot be reached it changes nothing.
#
# Cron, every 5 minutes (see README.md):
#   */5 * * * * /usr/local/bin/botblock-sync >> /var/log/botblock.log 2>&1
# ============================================================================

set -uo pipefail

LOG_PREFIX="[BotBlock-Sync]"

# Cron does not load the systemd EnvironmentFile, so read it here.
if [ -r /etc/default/botblock-watcher ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/default/botblock-watcher
  set +a
fi

# shellcheck source=botblock-lib.sh
. "$(dirname "$(readlink -f "$0")")/botblock-lib.sh"

require_root
ensure_chain

# ---- 1. Admin unblocks that the watcher has not picked up (or is not running) ----
process_unblocks

# ---- 2. Active blocks according to the database ----
if ! DB_IPS="$(db_query "select ip_address from blocked_ips where expires_at > now();")"; then
  log "Error: failed to query database (check /etc/default/botblock-watcher or ~/.pgpass); firewall left unchanged"
  exit 1
fi

declare -A DB_IP_SET=()
while IFS= read -r ip; do
  [ -z "$ip" ] && continue
  [ -n "$(ip_family "$ip")" ] || continue
  is_protected "$ip" && continue
  DB_IP_SET["${ip,,}"]=1
done <<< "$DB_IPS"

# ---- 3. Addresses currently in the chain ----
declare -A FW_IP_SET=()
while IFS= read -r ip; do
  [ -z "$ip" ] && continue
  FW_IP_SET["${ip,,}"]=1
done < <(fw_list)

# ---- 4. Add missing rules ----
added=0
for ip in "${!DB_IP_SET[@]}"; do
  if [ -z "${FW_IP_SET[$ip]+x}" ]; then
    if block_ip "$ip"; then
      log "ADDED $ip"
      added=$((added + 1))
    fi
  fi
done

# ---- 5. Remove rules that are no longer in the database (expired or unblocked) ----
removed=0
for ip in "${!FW_IP_SET[@]}"; do
  if [ -z "${DB_IP_SET[$ip]+x}" ]; then
    if unblock_ip "$ip"; then
      log "REMOVED $ip (expired or unblocked)"
      removed=$((removed + 1))
    fi
  fi
done

# ---- 6. Forget blocks that expired more than a week ago ----
db_query "delete from blocked_ips where expires_at < now() - interval '7 days';" >/dev/null || true

# ---- 7. Summary (silent when there is nothing to say, to keep the cron log short) ----
total=${#DB_IP_SET[@]}
if [ "$added" -gt 0 ] || [ "$removed" -gt 0 ]; then
  log "Sync complete: $total active blocks, +$added added, -$removed removed"
elif [ "$total" -gt 0 ] && [ -n "${BOTBLOCK_VERBOSE:-}" ]; then
  log "Sync complete: $total active blocks (no changes)"
fi
