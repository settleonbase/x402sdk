"use strict";
/**
 * Ordered createCard HTTP → Master → CCSA trace lines for journald / grep.
 *
 * Enable with: BEAMIO_CREATE_CARD_CHAIN_TRACE=1
 *
 * **systemd:** Exporting the variable in your SSH shell does NOT affect
 * `conet-beamio-api` (or any `systemctl` service). Set it on the unit, e.g.:
 *
 *   sudo systemctl edit conet-beamio-api.service
 *   # [Service]
 *   # Environment=BEAMIO_CREATE_CARD_CHAIN_TRACE=1
 *   sudo systemctl daemon-reload && sudo systemctl restart conet-beamio-api.service
 *
 * Each line: [BeamioCreateCardChain] {"step":"...","order":N,...}
 * Search: journalctl ... | grep BeamioCreateCardChain
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCreateCardChainTraceEnabled = isCreateCardChainTraceEnabled;
exports.resetCreateCardChainOrderForTests = resetCreateCardChainOrderForTests;
exports.emitCreateCardChainTrace = emitCreateCardChainTrace;
const ENV_KEY = 'BEAMIO_CREATE_CARD_CHAIN_TRACE';
function isCreateCardChainTraceEnabled() {
    return process.env[ENV_KEY] === '1' || process.env[ENV_KEY] === 'true';
}
let chainOrder = 0;
function nextOrder() {
    chainOrder += 1;
    return chainOrder;
}
function resetCreateCardChainOrderForTests() {
    chainOrder = 0;
}
/**
 * @param step Stable id, e.g. cluster.createCard.precheckPass
 * @param detail JSON-serializable fields only (no secrets / private keys)
 */
function emitCreateCardChainTrace(step, detail = {}) {
    if (!isCreateCardChainTraceEnabled())
        return;
    const payload = {
        step,
        order: nextOrder(),
        ts: new Date().toISOString(),
        pid: typeof process !== 'undefined' ? process.pid : null,
        ...detail,
    };
    try {
        console.warn(`[BeamioCreateCardChain] ${JSON.stringify(payload)}`);
    }
    catch {
        console.warn(`[BeamioCreateCardChain] {"step":"${step}","order":${payload.order},"error":"serialize_failed"}`);
    }
}
