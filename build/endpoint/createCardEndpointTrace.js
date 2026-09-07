"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.traceClusterCreateCardRouteHit = traceClusterCreateCardRouteHit;
exports.traceClusterCreateCardPrecheckPass = traceClusterCreateCardPrecheckPass;
exports.traceClusterCreateCardForwardingToMaster = traceClusterCreateCardForwardingToMaster;
exports.traceMasterCreateCardHandlerEnter = traceMasterCreateCardHandlerEnter;
exports.traceMasterCreateCardEnqueued = traceMasterCreateCardEnqueued;
exports.traceMasterInvokeCreateCardPoolPress = traceMasterInvokeCreateCardPoolPress;
exports.traceClusterCreateCardRequestBodyTiers = traceClusterCreateCardRequestBodyTiers;
exports.traceMasterCreateCardPoolEntryTiers = traceMasterCreateCardPoolEntryTiers;
/**
 * Call these from the full x402sdk tree (beamioServer worker, beamioMaster).
 * Import: from './endpoint/createCardEndpointTrace' or '../endpoint/createCardEndpointTrace' depending on file location.
 *
 * Tiers JSON: call traceClusterCreateCardRequestBodyTiers(body) in the worker right after
 * JSON parse / createCardPreCheck (same object forwarded to Master).
 */
const createCardChainTrace_1 = require("../createCardChainTrace");
const createCardTiersDebug_1 = require("../createCardTiersDebug");
/** Worker received POST /api/createCard (or mounted path). */
function traceClusterCreateCardRouteHit(method, path) {
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('cluster.createCard.routeHit', { method, path });
}
/** createCardPreCheck passed; about to forward to Master. */
function traceClusterCreateCardPrecheckPass(bodyKeyCount, hasCardOwner) {
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('cluster.createCard.precheckPass', { bodyKeyCount, hasCardOwner });
}
/** Right before postLocalhost('/api/createCard', ...). */
function traceClusterCreateCardForwardingToMaster(masterPortHint) {
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('cluster.createCard.forwardingToMaster', { masterPortHint: masterPortHint ?? null });
}
/** Master HTTP handler for /api/createCard entered. */
function traceMasterCreateCardHandlerEnter() {
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('master.createCard.handlerEnter', {});
}
/** After createCardPool.push — include pool length if cheap to pass. */
function traceMasterCreateCardEnqueued(poolLength) {
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('master.createCard.enqueued', { poolLength });
}
/** beamioMaster startup or tick invoked createCardPoolPress(). */
function traceMasterInvokeCreateCardPoolPress() {
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('master.createCard.invokeCreateCardPoolPress', {});
}
/** Cluster worker: tiers as received in parsed POST body (before forward to Master). */
function traceClusterCreateCardRequestBodyTiers(body) {
    (0, createCardTiersDebug_1.emitCreateCardTiersJson)('cluster.api.createCard.parsedBody.tiers', body?.tiers);
}
/** Master: tiers on the pooled job (same payload enqueued from Cluster). Optional if body is unchanged. */
function traceMasterCreateCardPoolEntryTiers(tiers) {
    (0, createCardTiersDebug_1.emitCreateCardTiersJson)('master.createCard.poolEntry.tiers', tiers);
}
