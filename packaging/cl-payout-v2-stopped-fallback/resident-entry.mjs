// Fixed hard-off entry: no runtime flag can switch this package to payment mode.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const reporterPath = path.join(pkgRoot, 'dist', 'endpoint', 'validatorClRewardPayoutReporter.js');

function fail(code) {
	console.error(`[stopped-fallback-entry] REFUSED ${code}`);
	process.exit(2);
}

if (globalThis.__conetWebSocketBan !== true) fail('NWS_PRELOAD_REQUIRED');
const stateFile = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE || '';
if (!path.isAbsolute(stateFile)) fail('ABSOLUTE_STATE_FILE_REQUIRED');
if (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ALLOW_FRESH_STATE === '1') fail('FRESH_STATE_FORBIDDEN');
process.umask(0o077);

const reporter = require(reporterPath);
const loaded = Object.keys(require.cache)
	.filter((k) => k.startsWith(pkgRoot + path.sep))
	.map((k) => path.relative(pkgRoot, k));
console.log(`[stopped-fallback-entry] PKG_MODULES ${loaded.join(' ')}`);
if (loaded.some((k) => /(^|[\\/])util\.js$/.test(k))) fail('FORBIDDEN_UTIL_MODULE');
if (typeof reporter.startStoppedPaymentFallback !== 'function' ||
	typeof reporter.stopValidatorClRewardPayoutReporter !== 'function') fail('REPORTER_API_MISSING');

let stopping = false;
let parkHandle;
const stop = () => {
	if (stopping) return;
	stopping = true;
	if (parkHandle) clearInterval(parkHandle);
	const forcedExit = setTimeout(() => process.exit(2), 1500);
	void reporter.stopValidatorClRewardPayoutReporter().then(() => {
		clearTimeout(forcedExit);
		console.log('[stopped-fallback-entry] PARK_RELEASED');
		process.exit(0);
	}, () => process.exit(2));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
	const state = reporter.startStoppedPaymentFallback();
	console.log(`[stopped-fallback-entry] STOP=${state} WORKERS=0 TRANSPORT=0`);
	parkHandle = setInterval(() => {}, 60_000);
} catch {
	fail('STATE_OR_WRITER_REFUSED');
}
