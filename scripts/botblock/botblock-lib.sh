#!/bin/bash
# ============================================================================
# botblock-lib.sh — shared by botblock-watcher.sh, sync-blocked-ips.sh and
# botblock-manual.sh. Sourced, not run.
#
# Ported from IndieCrowdfund's botblock-firewall and adapted to AltComix:
#   table blocked_ips (ip_address, expires_at), database "altcomix".
#
# Configuration comes from the environment. Both the systemd unit and the
# cron wrapper read /etc/default/botblock-watcher (see botblock.env.example).
# No credential is ever stored in the repository: either put DB_PASS in that
# root-only file, or leave it out and use ~/.pgpass for the user that runs
# the scripts (root).
# ============================================================================

CHAIN="${BOTBLOCK_CHAIN:-BOTBLOCK}"
PENDING_FILE="${BOTBLOCK_PENDING_FILE:-/tmp/botblock-pending}"   # written by api/src/lib/botblock.ts
UNBLOCK_FILE="${BOTBLOCK_UNBLOCK_FILE:-/tmp/botblock-unblock}"   # written by the admin "unblock" button
# Space-separated addresses that must never be dropped (your office, monitoring, a load balancer).
ALLOWLIST="${BOTBLOCK_ALLOWLIST:-}"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-altcomix}"
DB_NAME="${DB_NAME:-altcomix}"
# DB_PASS is optional: without it psql falls back to ~/.pgpass.

LOG_PREFIX="${LOG_PREFIX:-[BotBlock]}"

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $LOG_PREFIX $*"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "$LOG_PREFIX Error: must run as root (needed for iptables)" >&2
    exit 1
  fi
}

# Run a query, one value per line. Fails (non-zero) if the database cannot be reached.
db_query() {
  if [ -n "${DB_PASS:-}" ]; then
    PGPASSWORD="$DB_PASS" psql -X -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -w -t -A -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null
  else
    psql -X -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -w -t -A -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null
  fi
}

# Prints 4 or 6 for a well-formed address, nothing otherwise. Everything read
# from the files in /tmp goes through this before it gets near iptables.
ip_family() {
  local ip="$1" o
  if [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    for o in "${BASH_REMATCH[@]:1}"; do
      [ "$((10#$o))" -le 255 ] || return 0
    done
    echo 4
  elif [[ "$ip" =~ ^[0-9a-fA-F:]{2,39}$ && "$ip" == *:*:* ]]; then
    echo 6
  fi
}

# Loopback, private and link-local ranges, plus the allowlist: never dropped,
# whatever the application or an admin asked for.
is_protected() {
  local ip="$1" a
  case "$ip" in
    127.*|10.*|192.168.*|169.254.*|0.*|::1|fe80:*|FE80:*|fc*:*|fd*:*|FC*:*|FD*:*) return 0 ;;
    172.*)
      a="${ip#172.}"; a="${a%%.*}"
      [ "$a" -ge 16 ] && [ "$a" -le 31 ] && return 0 ;;
  esac
  for a in $ALLOWLIST; do
    [ "$a" = "$ip" ] && return 0
  done
  return 1
}

# iptables binary for an address family; empty if this host has no ip6tables.
fw_bin() {
  if [ "$1" = 6 ]; then
    command -v ip6tables >/dev/null 2>&1 && echo ip6tables
  else
    echo iptables
  fi
}

fw_mask() {
  [ "$1" = 6 ] && echo 128 || echo 32
}

# Create the chain and hook it into INPUT (once) for IPv4 and, if present, IPv6.
ensure_chain() {
  local bin
  for bin in iptables ip6tables; do
    command -v "$bin" >/dev/null 2>&1 || continue
    if ! "$bin" -n -L "$CHAIN" >/dev/null 2>&1; then
      log "Creating chain $CHAIN ($bin)"
      "$bin" -N "$CHAIN"
    fi
    if ! "$bin" -C INPUT -j "$CHAIN" 2>/dev/null; then
      log "Adding jump from INPUT to $CHAIN ($bin)"
      "$bin" -I INPUT -j "$CHAIN"
    fi
  done
}

# block_ip <ip>: 0 = rule added, 1 = already there, 2 = refused (invalid / protected / no ip6tables)
block_ip() {
  local ip="$1" fam bin
  fam="$(ip_family "$ip")"
  [ -n "$fam" ] || return 2
  is_protected "$ip" && return 2
  bin="$(fw_bin "$fam")"
  [ -n "$bin" ] || return 2
  "$bin" -C "$CHAIN" -s "$ip/$(fw_mask "$fam")" -j DROP 2>/dev/null && return 1
  "$bin" -A "$CHAIN" -s "$ip/$(fw_mask "$fam")" -j DROP
}

# unblock_ip <ip>: 0 = rule removed, 1 = there was no rule, 2 = invalid
unblock_ip() {
  local ip="$1" fam bin
  fam="$(ip_family "$ip")"
  [ -n "$fam" ] || return 2
  bin="$(fw_bin "$fam")"
  [ -n "$bin" ] || return 2
  "$bin" -D "$CHAIN" -s "$ip/$(fw_mask "$fam")" -j DROP 2>/dev/null || return 1
}

# Every address currently in the chain, one per line.
fw_list() {
  local bin
  for bin in iptables ip6tables; do
    command -v "$bin" >/dev/null 2>&1 || continue
    "$bin" -S "$CHAIN" 2>/dev/null | sed -n 's/^-A [^ ]* -s \([0-9a-fA-F:.]*\)\/[0-9]* -j DROP$/\1/p'
  done
}

# Take a queue file atomically (so nothing written meanwhile is lost) and
# print its distinct lines. The file is recreated by the next writer.
drain_file() {
  local file="$1" work
  [ -s "$file" ] || return 0
  # Refuse anything that is not a plain file: /tmp is world-writable.
  [ -f "$file" ] && [ ! -L "$file" ] || { log "SKIP $file: not a regular file"; return 0; }
  work="$(mktemp /run/botblock.XXXXXX 2>/dev/null || mktemp)"
  mv -f "$file" "$work" 2>/dev/null || { rm -f "$work"; return 0; }
  sort -u "$work"
  rm -f "$work"
}

# Remove firewall rules for addresses an admin unblocked in /admin.
process_unblocks() {
  local ip
  while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    unblock_ip "$ip"
    case $? in
      0) log "UNBLOCKED $ip (admin)" ;;
      2) log "SKIP invalid IP in unblock file: ${ip:0:60}" ;;
    esac
  done < <(drain_file "$UNBLOCK_FILE")
}

# Add firewall rules for addresses the application just blocked.
process_pending() {
  local ip
  while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    block_ip "$ip"
    case $? in
      0) log "BLOCKED $ip (instant)" ;;
      2) log "SKIP invalid or protected IP: ${ip:0:60}" ;;
    esac
  done < <(drain_file "$PENDING_FILE")
}
