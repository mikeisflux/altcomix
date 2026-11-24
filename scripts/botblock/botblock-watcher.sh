#!/bin/bash
# ============================================================================
# botblock-watcher.sh
#
# Fast loop that turns the API's block decisions into iptables DROP rules
# within seconds, instead of waiting for the 5-minute sync-blocked-ips.sh cron.
#
#   /tmp/botblock-pending   one IP per line, appended by api/src/lib/botblock.ts
#                           (automatic blocks) and by the admin "block" form
#   /tmp/botblock-unblock   one IP per line, appended when an admin unblocks
#
# On start it restores every active block from the blocked_ips table, so
# rules survive reboots.
#
# Install as a systemd service (see README.md):
#   sudo cp botblock-watcher.service /etc/systemd/system/
#   sudo systemctl enable --now botblock-watcher
#
# Run once by hand (one pass, no loop):
#   sudo BOTBLOCK_ONCE=1 bash botblock-watcher.sh
# ============================================================================

set -uo pipefail

LOG_PREFIX="[BotBlock-Watcher]"
INTERVAL="${BOTBLOCK_INTERVAL:-5}"  # seconds between checks

# shellcheck source=botblock-lib.sh
. "$(dirname "$(readlink -f "$0")")/botblock-lib.sh"

require_root
ensure_chain

# ---- On startup, restore all active blocks from the database ----
log "Restoring blocked IPs from database on startup..."
restored=0
if RESTORE_IPS="$(db_query "select ip_address from blocked_ips where expires_at > now();")"; then
  while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    if block_ip "$ip"; then
      restored=$((restored + 1))
    fi
  done <<< "$RESTORE_IPS"
  if [ "$restored" -gt 0 ]; then
    log "Restored $restored blocked IPs from database"
  else
    log "No blocked IPs to restore (or already in iptables)"
  fi
else
  log "Warning: could not query the database for the startup restore (check /etc/default/botblock-watcher or ~/.pgpass). New blocks are still applied."
fi

log "Watcher started — monitoring $PENDING_FILE and $UNBLOCK_FILE every ${INTERVAL}s"

while true; do
  # Unblocks first: if an address was unblocked and then blocked again, the block wins.
  process_unblocks
  process_pending

  [ -n "${BOTBLOCK_ONCE:-}" ] && break
  sleep "$INTERVAL"
done
