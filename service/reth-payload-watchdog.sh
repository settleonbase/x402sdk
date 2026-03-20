#!/usr/bin/env bash
set -Eeuo pipefail

LOG_TAG="reth-payload-watchdog"
SERVICE="base-op-reth-native.service"
CHECK_INTERVAL=5
STALL_SECONDS=180
LOOKBACK_SECONDS=240
POST_RESTART_GRACE=15
RESTART_RECORD="/home/peter/base/reth-payload-watchdog-restarts.log"

last_num=-1
last_change_ts=$(date +%s)

log() {
  echo "$(date '+%F %T %Z') [$LOG_TAG] $*"
}

record_restart() {
  local idle="$1"
  local before_pid="$2"
  local after_pid="$3"
  printf '%s | service=%s | action=restart | idle_seconds=%s | last_payload=%s | pid_before=%s | pid_after=%s\n' \
    "$(date '+%F %T %Z')" \
    "$SERVICE" \
    "$idle" \
    "$last_num" \
    "$before_pid" \
    "$after_pid" >> "$RESTART_RECORD"
}

extract_latest_num() {
  # Pipe journal into Python (avoid ARG_MAX / "Argument list too long")
  sudo journalctl -u "$SERVICE" --since "${LOOKBACK_SECONDS} seconds ago" --no-pager 2>/dev/null \
    | python3 -c '
import re, sys
text = sys.stdin.read()
nums = [int(m.group(1)) for m in re.finditer(
    r"Received new payload from consensus engine\s+number=(\d+)", text)]
print(max(nums) if nums else "")
'
}

seed_recent() {
  local num
  num=$(extract_latest_num)
  if [[ -n "$num" ]]; then
    last_num=$num
    last_change_ts=$(date +%s)
    log "seed payload number=$num"
  else
    last_change_ts=$(date +%s)
    log "no recent payload found; timer starts now"
  fi
}

restart_reth() {
  local idle before_pid after_pid
  idle=$(( $(date +%s) - last_change_ts ))
  before_pid=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo "unknown")
  log "no new payload for ${STALL_SECONDS}s, restarting ${SERVICE}"
  sudo systemctl restart "$SERVICE"
  after_pid=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo "unknown")
  record_restart "$idle" "$before_pid" "$after_pid"
  last_num=-1
  last_change_ts=$(date +%s)
  sleep "$POST_RESTART_GRACE"
  seed_recent
}

touch "$RESTART_RECORD"
log "daemon started: stall=${STALL_SECONDS}s interval=${CHECK_INTERVAL}s record=${RESTART_RECORD}"
seed_recent

while true; do
  now=$(date +%s)
  num=$(extract_latest_num)

  if [[ -n "$num" ]] && (( num > last_num )); then
    last_num=$num
    last_change_ts=$now
    log "new payload number=$num"
  fi

  idle=$((now - last_change_ts))
  if (( idle >= STALL_SECONDS )); then
    restart_reth
  fi

  sleep "$CHECK_INTERVAL"
done
