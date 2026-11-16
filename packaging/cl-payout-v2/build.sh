#!/bin/bash
# 复现 cl-payout-v2 冻结包（同包 88cdc832）。依赖锁：本仓库 package-lock.json / tsconfig.json；编译器 typescript 5.8.3。
# 用法：OUT=<仓库外输出目录> NM=<含 typescript@5.8.3 与 ethers 的 node_modules 目录> bash packaging/cl-payout-v2/build.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${OUT:?set OUT to an output directory outside the repository}"
: "${NM:?set NM to a node_modules directory containing typescript 5.8.3}"
HERE="$ROOT/packaging/cl-payout-v2"
TSV=$(node -p "require('$NM/typescript/package.json').version")
[ "$TSV" = "5.8.3" ] || { echo "FATAL typescript=$TSV, expected 5.8.3"; exit 2; }
SHA=$(command -v sha256sum >/dev/null 2>&1 && echo "sha256sum" || echo "shasum -a 256")
[ -e "$ROOT/node_modules" ] || { ln -s "$NM" "$ROOT/node_modules"; CREATED_LINK=1; }
rm -rf "$OUT/build" "$OUT/cl-payout-v2"; mkdir -p "$OUT"
"$NM/.bin/tsc" -p "$ROOT/tsconfig.json" --outDir "$OUT/build"
PKG="$OUT/cl-payout-v2"; mkdir -p "$PKG/dist/endpoint" "$PKG/signer/dist/src"
for f in endpoint/validatorClRewardPayoutReporter.js endpoint/vdrDualCursor.js endpoint/vdrPayoutSigner.js chainAddresses.js logger.js onchainTxSerialQueue.js; do cp "$OUT/build/$f" "$PKG/dist/$f"; done
cp "$HERE/resident-entry.mjs" "$HERE/STARTUP.txt" "$HERE/package.json" "$PKG/"
cp "$HERE/vendor/noWebSocket.js" "$PKG/signer/dist/src/noWebSocket.js"
(cd "$PKG" && $SHA -c "$HERE/MANIFEST.expected.sha256")
[ -L "$ROOT/node_modules" ] && [ "${CREATED_LINK:-0}" = "1" ] && rm -f "$ROOT/node_modules" || true
echo "REPRODUCED: $PKG (typescript $TSV, manifest matches MANIFEST.expected.sha256)"
