#!/usr/bin/env bash
# Run op-reth MDBX hot backup inside tmux; append logs to db-copy.log.
# Intended for the Linux Base node. See OP-RETH-DB-COPY-HOT-BACKUP.md
set -euo pipefail

OP_RETH_BIN="${OP_RETH_BIN:-/media/sda/bin/op-reth-v1.11.3-rc.3}"
DATADIR="${DATADIR:-/home/peter/base/op-reth}"
STATIC="${STATIC:-/media/sda/base/op-reth-static}"
CHAIN="${CHAIN:-base}"
LOG="${LOG:-$HOME/db-copy.log}"
DEST="${DEST:-/media/sda/baseBackup-$(date +%Y%m%d-%H%M%S)}"
SESSION="${TMUX_SESSION:-op-reth-db-copy}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "WARN: This script targets Linux (op-reth + /media/sda). Current: $(uname -s)" >&2
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux not found." >&2
  exit 1
fi

if [[ ! -x "$OP_RETH_BIN" ]]; then
  echo "ERROR: op-reth binary not executable: $OP_RETH_BIN" >&2
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists."
  echo "  Attach:  tmux attach -t $SESSION"
  echo "  Or kill: tmux kill-session -t $SESSION"
  exit 1
fi

RUNNER="$(mktemp)"
trap 'rm -f "$RUNNER"' EXIT

{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf 'OP_RETH_BIN=%q\n' "$OP_RETH_BIN"
  printf 'DATADIR=%q\n' "$DATADIR"
  printf 'STATIC=%q\n' "$STATIC"
  printf 'CHAIN=%q\n' "$CHAIN"
  printf 'LOG=%q\n' "$LOG"
  printf 'DEST=%q\n' "$DEST"
  cat <<'INNER'
echo "=== db copy start $(date -Is) ===" | tee -a "$LOG"
echo "DEST=$DEST" | tee -a "$LOG"
"$OP_RETH_BIN" db \
  --datadir "$DATADIR" \
  --datadir.static-files "$STATIC" \
  --chain "$CHAIN" \
  copy -p "$DEST" \
  2>&1 | tee -a "$LOG"
code="${PIPESTATUS[0]}"
echo "=== db copy end $(date -Is) exit=$code ===" | tee -a "$LOG"
exit "$code"
INNER
} >"$RUNNER"

chmod +x "$RUNNER"
tmux new-session -d -s "$SESSION" "$RUNNER"

echo "Started tmux session: $SESSION"
echo "  Log file:    $LOG   (tail -n 200 \"$LOG\")"
echo "  Destination: $DEST"
echo "  Attach:      tmux attach -t $SESSION"
echo "  Detach:      Ctrl+B then D"
