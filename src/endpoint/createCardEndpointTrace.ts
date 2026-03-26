/**
 * Call these from the full x402sdk tree (beamioServer worker, beamioMaster).
 * Import: from './endpoint/createCardEndpointTrace' or '../endpoint/createCardEndpointTrace' depending on file location.
 *
 * Tiers JSON: call traceClusterCreateCardRequestBodyTiers(body) in the worker right after
 * JSON parse / createCardPreCheck (same object forwarded to Master).
 */
import { emitCreateCardChainTrace } from '../createCardChainTrace'
import { emitCreateCardTiersJson } from '../createCardTiersDebug'

/** Worker received POST /api/createCard (or mounted path). */
export function traceClusterCreateCardRouteHit(method: string, path: string): void {
  emitCreateCardChainTrace('cluster.createCard.routeHit', { method, path })
}

/** createCardPreCheck passed; about to forward to Master. */
export function traceClusterCreateCardPrecheckPass(bodyKeyCount: number, hasCardOwner: boolean): void {
  emitCreateCardChainTrace('cluster.createCard.precheckPass', { bodyKeyCount, hasCardOwner })
}

/** Right before postLocalhost('/api/createCard', ...). */
export function traceClusterCreateCardForwardingToMaster(masterPortHint?: string): void {
  emitCreateCardChainTrace('cluster.createCard.forwardingToMaster', { masterPortHint: masterPortHint ?? null })
}

/** Master HTTP handler for /api/createCard entered. */
export function traceMasterCreateCardHandlerEnter(): void {
  emitCreateCardChainTrace('master.createCard.handlerEnter', {})
}

/** After createCardPool.push — include pool length if cheap to pass. */
export function traceMasterCreateCardEnqueued(poolLength: number): void {
  emitCreateCardChainTrace('master.createCard.enqueued', { poolLength })
}

/** beamioMaster startup or tick invoked createCardPoolPress(). */
export function traceMasterInvokeCreateCardPoolPress(): void {
  emitCreateCardChainTrace('master.createCard.invokeCreateCardPoolPress', {})
}

/** Cluster worker: tiers as received in parsed POST body (before forward to Master). */
export function traceClusterCreateCardRequestBodyTiers(body: { tiers?: unknown } | null | undefined): void {
  emitCreateCardTiersJson('cluster.api.createCard.parsedBody.tiers', body?.tiers)
}

/** Master: tiers on the pooled job (same payload enqueued from Cluster). Optional if body is unchanged. */
export function traceMasterCreateCardPoolEntryTiers(tiers: unknown): void {
  emitCreateCardTiersJson('master.createCard.poolEntry.tiers', tiers)
}
