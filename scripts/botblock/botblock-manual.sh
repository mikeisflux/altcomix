#!/bin/bash
# ============================================================================
# botblock-manual.sh — look at or change the firewall chain by hand.
#
#   sudo botblock-manual list
#   sudo botblock-manual count
#   sudo botblock-manual block 203.0.113.9
#   sudo botblock-manual unblock 203.0.113.9
#   sudo botblock-manual flush
#
# This only touches iptables. A block made here is not in the database, so
# the next sync removes it; an unblock made here comes back at the next sync
# if the block is still active in /admin. For anything meant to last, use
# Admin > Security > Blocked IPs, which records the reason and an audit entry.
# ============================================================================

set -uo pipefail

LOG_PREFIX="[BotBlock-Manual]"
# shellcheck source=botblock-lib.sh
. "$(dirname "$(readlink -f "$0")")/botblock-lib.sh"

usage() {
  echo "Usage: $0 {block|unblock|list|flush|count} [IP]"
  echo ""
  echo "  block   <IP>   Add a DROP rule now (temporary: see the note in this script)"
  echo "  unblock <IP>   Remove the DROP rule"
  echo "  list           Show every blocked address"
  echo "  count          Show how many addresses are blocked"
  echo "  flush          Remove every rule from the chain"
  exit 1
}

require_root

case "${1:-}" in
  block)
    ip="${2:-}"
    [ -n "$ip" ] || usage
    ensure_chain
    block_ip "$ip"
    case $? in
      0) echo "Blocked: $ip" ;;
      1) echo "IP $ip is already blocked" ;;
      *) echo "Error: $ip is not a valid address, or is a protected (loopback / private / allowlisted) address" >&2; exit 1 ;;
    esac
    ;;
  unblock)
    ip="${2:-}"
    [ -n "$ip" ] || usage
    ensure_chain
    unblock_ip "$ip"
    case $? in
      0) echo "Unblocked: $ip" ;;
      1) echo "IP $ip was not blocked" ;;
      *) echo "Error: invalid address: $ip" >&2; exit 1 ;;
    esac
    ;;
  list)
    ensure_chain
    echo "Currently blocked IPs in $CHAIN chain:"
    echo "----------------------------------------"
    fw_list | sort
    ;;
  count)
    ensure_chain
    echo "$(fw_list | wc -l) IPs currently blocked"
    ;;
  flush)
    ensure_chain
    count="$(fw_list | wc -l)"
    for bin in iptables ip6tables; do
      command -v "$bin" >/dev/null 2>&1 && "$bin" -F "$CHAIN"
    done
    echo "Flushed $count blocked IPs from $CHAIN chain"
    ;;
  *)
    usage
    ;;
esac
