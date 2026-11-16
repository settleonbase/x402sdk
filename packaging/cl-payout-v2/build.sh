#!/bin/bash
# 复现 cl-payout-v2 当前发布包。校验清单为 MANIFEST.expected.sha256（当前包）。
# 冻结包 88cdc832 的原清单已移为历史文件 MANIFEST.frozen-88cdc832.sha256，不参与校验。
# 编译器：packaging/cl-payout-v2/tsconfig.json（仅 reporter 闭合的 6 个文件），typescript 5.8.3。
# 依赖：NM 须为干净依赖树，至少含 typescript@5.8.3、ethers@6.16.0、colors@1.4.0、@types/node（及 ethers 传递依赖）。
# 用法：OUT=<仓库外输出目录> NM=<干净依赖树 node_modules> [VERIFY_NWS=1] bash packaging/cl-payout-v2/build.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/packaging/cl-payout-v2"
: "${OUT:?set OUT to an output directory outside the repository}"
: "${NM:?set NM to a clean node_modules directory}"
rv() { node -p "require('$NM/$1/package.json').version" 2>/dev/null || echo ABSENT; }
[ "$(rv typescript)" = "5.8.3" ] || { echo "FATAL typescript=$(rv typescript), expected 5.8.3"; exit 2; }
[ "$(rv ethers)" = "6.16.0" ] || { echo "FATAL ethers=$(rv ethers), expected 6.16.0"; exit 2; }
[ "$(rv colors)" = "1.4.0" ] || { echo "FATAL colors=$(rv colors), expected 1.4.0"; exit 2; }
[ "$(rv @types/node)" != "ABSENT" ] || { echo "FATAL @types/node missing"; exit 2; }
[ -f "$NM/@types/node/package.json" ] || { echo "FATAL @types/node/package.json not in NM"; exit 4; }
SHA=$(command -v sha256sum >/dev/null 2>&1 && echo "sha256sum" || echo "shasum -a 256")
CREATED_LINK=0
trap 'if [ "$CREATED_LINK" = "1" ]; then rm -f "$ROOT/node_modules"; fi' EXIT
if [ ! -e "$ROOT/node_modules" ] && [ ! -L "$ROOT/node_modules" ]; then ln -s "$NM" "$ROOT/node_modules"; CREATED_LINK=1; fi
if [ ! -L "$ROOT/node_modules" ] || [ "$(readlink "$ROOT/node_modules")" != "$NM" ]; then echo "FATAL: $ROOT/node_modules must be a symlink to NM=$NM"; exit 4; fi
for p in ethers colors; do
  r=$(cd "$ROOT" && node -p "require.resolve('$p')" 2>/dev/null || echo none)
  case "$r" in "$NM"/*) ;; *) echo "FATAL: $p does not resolve inside NM (got: $r)"; exit 4 ;; esac
done
rm -rf "$OUT/build" "$OUT/cl-payout-v2"; mkdir -p "$OUT"
node "$NM/typescript/bin/tsc" -p "$HERE/tsconfig.json" --outDir "$OUT/build"
PKG="$OUT/cl-payout-v2"; mkdir -p "$PKG/dist/endpoint" "$PKG/signer/dist/src"
for f in endpoint/validatorClRewardPayoutReporter.js endpoint/vdrDualCursor.js endpoint/vdrPayoutSigner.js chainAddresses.js logger.js onchainTxSerialQueue.js; do cp "$OUT/build/$f" "$PKG/dist/$f"; done
cp "$HERE/resident-entry.mjs" "$HERE/STARTUP.txt" "$HERE/package.json" "$PKG/"
if [ "${VERIFY_NWS:-0}" = "1" ]; then
  rm -rf "$OUT/nws-verify"
  node "$NM/typescript/bin/tsc" -p "$HERE/noWebSocket-src/tsconfig.json" --outDir "$OUT/nws-verify"
  cmp -s "$OUT/nws-verify/src/noWebSocket.js" "$HERE/vendor/noWebSocket.js" || { echo "FATAL: noWebSocket source does not reproduce vendor"; exit 3; }
  echo "noWebSocket source reproduces vendor/noWebSocket.js byte-identical"
fi
cp "$HERE/vendor/noWebSocket.js" "$PKG/signer/dist/src/noWebSocket.js"
(cd "$PKG" && $SHA -c "$HERE/MANIFEST.expected.sha256")
if [ "$CREATED_LINK" = "1" ]; then rm -f "$ROOT/node_modules"; fi
echo "REPRODUCED: $PKG (typescript 5.8.3, manifest matches MANIFEST.expected.sha256)"
