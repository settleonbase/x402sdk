"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.traceMemberCardCreateCardPoolPressDequeue = traceMemberCardCreateCardPoolPressDequeue;
exports.traceMemberCardCreateBeamioCardAdminWithHashEnter = traceMemberCardCreateBeamioCardAdminWithHashEnter;
exports.traceMemberCardDelegateToCCSA = traceMemberCardDelegateToCCSA;
/**
 * Wire-up in full repo `src/MemberCard.ts`:
 * - At start of `createCardPoolPress`, after dequeuing SC + job, call `traceMemberCardCreateCardPoolPressDequeue`.
 * - Optional tiers log: `traceMasterCreateCardPoolEntryTiers(job.tiers)` from `./endpoint/createCardEndpointTrace`.
 * - At start of `createBeamioCardAdminWithHash`, call `traceMemberCardCreateBeamioCardAdminWithHashEnter`.
 * - Immediately before `return createBeamioCardWithFactoryReturningHash(...)` / `return createBeamioCardWithFactory(...)`, call `traceMemberCardDelegateToCCSA`.
 *
 * Worker (`beamioServer`): after parsing createCard body, `traceClusterCreateCardRequestBodyTiers(body)`.
 */
const createCardChainTrace_1 = require("./createCardChainTrace");
function traceMemberCardCreateCardPoolPressDequeue(payload) {
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('MemberCard.createCardPoolPress.dequeue', payload);
}
function traceMemberCardCreateBeamioCardAdminWithHashEnter(payload) {
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('MemberCard.createBeamioCardAdminWithHash.enter', payload);
}
/** Right before delegating to CCSA (same process, same dist bundle). */
function traceMemberCardDelegateToCCSA(mode) {
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('MemberCard.delegateToCCSA', { mode });
}
