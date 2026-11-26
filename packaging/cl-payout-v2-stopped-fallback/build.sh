#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/packaging/cl-payout-v2-stopped-fallback"
BASE="$ROOT/packaging/cl-payout-v2"
: "${OUT:?set OUT to a new output directory outside the repository}"
: "${NM:?set NM to the pinned offline node_modules directory}"
[ ! -e "$OUT" ] || { echo "FATAL OUT_ALREADY_EXISTS"; exit 20; }
mkdir -p "$OUT"
if command -v sha256sum >/dev/null 2>&1; then SHA=sha256sum; else SHA=shasum; fi
rv() { node -p "require('$NM/$1/package.json').version" 2>/dev/null || echo ABSENT; }
[ "$(rv typescript)" = "5.8.3" ] || { echo "FATAL_TYPESCRIPT_VERSION"; exit 2; }
[ "$(rv ethers)" = "6.16.0" ] || { echo "FATAL_ETHERS_VERSION"; exit 2; }
[ "$(rv colors)" = "1.4.0" ] || { echo "FATAL_COLORS_VERSION"; exit 2; }
[ "$(rv @types/node)" != "ABSENT" ] || { echo "FATAL_NODE_TYPES_MISSING"; exit 2; }
[ -L "$ROOT/node_modules" ] && [ "$(readlink "$ROOT/node_modules")" = "$NM" ] || { echo "FATAL_NODE_MODULES_LINK_NOT_PINNED"; exit 4; }
for p in ethers colors; do
	r=$(cd "$ROOT" && node -p "require.resolve('$p')" 2>/dev/null || echo none)
	case "$r" in "$NM"/*) ;; *) echo "FATAL_DEPENDENCY_RESOLUTION"; exit 4 ;; esac
done
node "$NM/typescript/bin/tsc" -p "$BASE/tsconfig.json" --outDir "$OUT/build"
PKG="$OUT/cl-payout-v2-stopped-fallback"
mkdir -p "$PKG/dist/endpoint" "$PKG/signer/dist/src"
for f in endpoint/validatorClRewardPayoutReporter.js endpoint/vdrDualCursor.js endpoint/vdrPayoutSigner.js chainAddresses.js logger.js onchainTxSerialQueue.js; do cp "$OUT/build/$f" "$PKG/dist/$f"; done
cp "$HERE/resident-entry.mjs" "$HERE/STARTUP.txt" "$HERE/package.json" "$PKG/"
cp "$BASE/vendor/noWebSocket.js" "$PKG/signer/dist/src/noWebSocket.js"
[ -s "$HERE/MANIFEST.expected.sha256" ] || { echo "FATAL_MANIFEST_NOT_SEALED"; exit 21; }
if [ "$SHA" = "sha256sum" ]; then
	(cd "$PKG" && sha256sum -c "$HERE/MANIFEST.expected.sha256")
else
	(cd "$PKG" && shasum -a 256 -c "$HERE/MANIFEST.expected.sha256")
fi
cp "$HERE/MANIFEST.expected.sha256" "$PKG/MANIFEST.expected.sha256"
echo "STOPPED_FALLBACK_PACKAGE=$PKG"
