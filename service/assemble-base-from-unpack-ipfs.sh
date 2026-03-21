#!/usr/bin/env bash
# Assemble /home/peter/base from Base pruned snapshot unpack on ipfs.conet.network.
# - Move db/blobstore/reth.toml/etc. into /home/peter/base/op-reth
# - Rsync static_files -> /media/sda/base/op-reth-static, then delete snapshot static + etl-tmp
# - Set [stages.etl] dir to /media/sda/baseTemp; create that directory
# Run on the server as user with sudo (e.g. peter).
set -euo pipefail

UNPACK="${UNPACK:-/home/peter/base-mainnet-pruned-reth-1772096746-unpack}"
SRC="$UNPACK/snapshots/mainnet/download"
BASE=/home/peter/base
OP_RETH="$BASE/op-reth"
STATIC=/media/sda/base/op-reth-static
TEMP=/media/sda/baseTemp
LOG="${LOG:-/home/peter/assemble-base-$(date +%Y%m%d-%H%M%S).log}"

exec > >(tee -a "$LOG") 2>&1

echo "=== assemble start $(date -Is) ==="
echo "SRC=$SRC UNPACK=$UNPACK"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: snapshot download dir missing: $SRC"
  exit 1
fi

sudo systemctl stop base-op-reth-native.service base-op-node-native.service 2>/dev/null || true

sudo mkdir -p "$BASE"/{op-reth,op-node,jwt,config} "$STATIC" "$TEMP"
sudo chown -R peter:peter "$BASE" "$STATIC" "$TEMP"

echo "=== clear op-reth datadir (jwt untouched) ==="
if [[ -d "$OP_RETH" ]]; then
  sudo find "$OP_RETH" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
fi
sudo mkdir -p "$OP_RETH"
sudo chown peter:peter "$OP_RETH"

echo "=== mv main datadir from snapshot ==="
mv "$SRC/db" "$OP_RETH/"
mv "$SRC/blobstore" "$OP_RETH/"
mv "$SRC/reth.toml" "$OP_RETH/"
[[ -f "$SRC/known-peers.json" ]] && mv "$SRC/known-peers.json" "$OP_RETH/"
[[ -d "$SRC/invalid_block_hooks" ]] && mv "$SRC/invalid_block_hooks" "$OP_RETH/"

echo "=== rsync static_files -> $STATIC (may take a long time) ==="
sudo rsync -a --delete "$SRC/static_files/" "$STATIC/"
sudo chown -R peter:peter "$STATIC"

echo "=== delete static + etl-tmp under snapshot (free /home) ==="
rm -rf "$SRC/static_files" "$SRC/etl-tmp"

echo "=== ensure reth.toml [stages.etl] dir -> $TEMP ==="
python3 <<'PY'
import re
from pathlib import Path
path = Path("/home/peter/base/op-reth/reth.toml")
text = path.read_text()
want = '"/media/sda/baseTemp"'
# Replace existing dir = line after [stages.etl]
pat = re.compile(
    r'(\[stages\.etl\]\s*\n)(dir\s*=\s*)("[^"]*"|[^\n]+)',
    re.MULTILINE,
)
new_text, n = pat.subn(r"\1\2" + want, text, count=1)
if n == 1:
    path.write_text(new_text)
    print("patched existing dir line")
elif "[stages.etl]" in text and want not in text:
    new_text = text.replace("[stages.etl]\n", f"[stages.etl]\ndir = {want}\n", 1)
    if new_text == text:
        raise SystemExit("Could not insert dir under [stages.etl]")
    path.write_text(new_text)
    print("inserted dir line (snapshot had no dir)")
else:
    print("no change needed")
PY
sudo chown peter:peter "$OP_RETH/reth.toml"

echo "=== normalize prune.segments distance: 1339200 -> 2678400 (match full-node-style window) ==="
sed -i 's/^distance = 1339200$/distance = 2678400/' "$OP_RETH/reth.toml"

if [[ ! -s "$BASE/jwt/jwt.hex" ]]; then
  echo "=== create jwt.hex ==="
  openssl rand -hex 32 | tr -d '\n' | sudo tee "$BASE/jwt/jwt.hex" >/dev/null
  sudo chown peter:peter "$BASE/jwt/jwt.hex"
  sudo chmod 600 "$BASE/jwt/jwt.hex"
fi

echo "=== remove unpack tree $UNPACK ==="
rm -rf "$UNPACK"

echo "=== verify ==="
ls -la "$OP_RETH"
du -sh "$OP_RETH" "$STATIC" "$TEMP" || true
grep -A2 '^\[stages\.etl\]' "$OP_RETH/reth.toml" || true

echo "=== assemble end $(date -Is) ==="
echo "Log: $LOG"
echo "Next: sudo systemctl start base-op-reth-native.service && sudo systemctl start base-op-node-native.service"
