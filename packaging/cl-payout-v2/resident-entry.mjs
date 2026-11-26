// 常驻入口（冻结包内，随包冻结）。启动方式见同目录 STARTUP.txt：
//   node -r ./signer/dist/src/noWebSocket.js ./resident-entry.mjs
// 只加载包内 reporter（dist/endpoint/validatorClRewardPayoutReporter.js）；不加载 ../util，不读 ~/.master.json。
// RPC 必须由 CONET_VALIDATOR_DEPOSIT_RPC_URL 显式给出（http(s)），否则拒绝启动（非零退出）。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const reporterPath = path.join(pkgRoot, 'dist', 'endpoint', 'validatorClRewardPayoutReporter.js');

function fail(msg) {
	console.error(`[resident-entry] FATAL ${msg}`);
	process.exit(2);
}

if (globalThis.__conetWebSocketBan !== true) {
	fail('noWebSocket preload missing: start with node -r ./signer/dist/src/noWebSocket.js');
}
const rpc = (process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL || '').trim();
if (!rpc) fail('CONET_VALIDATOR_DEPOSIT_RPC_URL is required (master.json is not read)');
if (!/^https?:\/\//i.test(rpc)) fail('CONET_VALIDATOR_DEPOSIT_RPC_URL must be http(s); ws/wss refused');

const reporter = require(reporterPath);
const loaded = Object.keys(require.cache)
	.filter((k) => k.startsWith(pkgRoot + path.sep))
	.map((k) => path.relative(pkgRoot, k));
console.log(`[resident-entry] PKG_MODULES ${loaded.join(' ')}`);
if (loaded.some((k) => /(^|[\\/])util\.js$/.test(k))) fail('forbidden module ../util loaded');
if (typeof reporter.startValidatorClRewardPayoutReporter !== 'function') fail('reporter API missing');

let stopping = false;
const stopAll = () => {
	if (stopping) return;
	stopping = true;
	const forcedExit = setTimeout(() => process.exit(2), 1500);
	void reporter.stopValidatorClRewardPayoutReporter().then(() => {
		clearTimeout(forcedExit);
		process.exit(0);
	}, () => {
		process.exit(2);
	});
};
process.on('SIGTERM', stopAll);
process.on('SIGINT', stopAll);

try {
	reporter.startValidatorClRewardPayoutReporter();
} catch (e) {
	fail(`start refused: ${e?.message ?? e} (state file untouched)`);
}

const runMs = Number(process.env.RESIDENT_RUN_MS || 0);
if (Number.isFinite(runMs) && runMs > 0) setTimeout(stopAll, runMs);
