/**
 * Call these from the full x402sdk tree (beamioServer worker, beamioMaster).
 * Import: from './endpoint/createCardEndpointTrace' or '../endpoint/createCardEndpointTrace' depending on file location.
 */
import { emitCreateCardChainTrace } from '../createCardChainTrace'

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
