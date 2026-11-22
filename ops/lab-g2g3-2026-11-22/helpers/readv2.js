'use strict'
// READ-ONLY check with the OLD build's own state reader (df78e6b): can the old build read this state directory, and what does it see?
// usage: node readv2.js <path to labClPayoutStateStore.js (the old build's dist/endpoint/...)> <state dir (…/<name>.v2)>
// prints one JSON line. exit 0 = readable (a plain version 2 state); exit 3 = refused (e.g. a version 3 / WAL state: "unsupported version"). It never writes.
const path = require('path')
const [, , modPath, dir] = process.argv
if (!modPath || !dir) {
	console.error('usage: node readv2.js <labClPayoutStateStore.js> <state dir>')
	process.exit(2)
}
const m = require(path.resolve(modPath))
try {
	const st = m.readSegmentedState(dir)
	console.log(
		JSON.stringify({
			ok: true,
			pending: st.pending.length,
			consumed: Object.keys(st.consumedEventKeys).length,
			exited: Object.keys(st.exitedPubkeys).length,
			historyCursor: st.historyCursor ?? null,
			realtimeCursor: st.realtimeCursor ?? null,
			freezeHeight: st.freezeH ? st.freezeH.height : null,
			settledBatchCount: st.settledBatchCount ?? null,
			inFlightWithdraw: st.inFlightWithdraw ? { idempotencyKey: st.inFlightWithdraw.idempotencyKey, eventKeys: (st.inFlightWithdraw.eventKeys || []).length, hash: st.inFlightWithdraw.hash || null } : null,
		})
	)
} catch (e) {
	console.log(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e).replace(dir, '<dir>') }))
	process.exit(3)
}
