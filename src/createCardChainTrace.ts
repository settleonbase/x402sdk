/**
 * Ordered createCard HTTP → Master → CCSA trace lines for journald / grep.
 * Enable with: BEAMIO_CREATE_CARD_CHAIN_TRACE=1
 *
 * Each line: [BeamioCreateCardChain] {"step":"...","order":N,...}
 * Search: BeamioCreateCardChain
 */

const ENV_KEY = 'BEAMIO_CREATE_CARD_CHAIN_TRACE'

export function isCreateCardChainTraceEnabled(): boolean {
  return process.env[ENV_KEY] === '1' || process.env[ENV_KEY] === 'true'
}

let chainOrder = 0

function nextOrder(): number {
  chainOrder += 1
  return chainOrder
}

export function resetCreateCardChainOrderForTests(): void {
  chainOrder = 0
}

/**
 * @param step Stable id, e.g. cluster.createCard.precheckPass
 * @param detail JSON-serializable fields only (no secrets / private keys)
 */
export function emitCreateCardChainTrace(step: string, detail: Record<string, unknown> = {}): void {
  if (!isCreateCardChainTraceEnabled()) return
  const payload = {
    step,
    order: nextOrder(),
    ts: new Date().toISOString(),
    pid: typeof process !== 'undefined' ? process.pid : null,
    ...detail,
  }
  try {
    console.warn(`[BeamioCreateCardChain] ${JSON.stringify(payload)}`)
  } catch {
    console.warn(`[BeamioCreateCardChain] {"step":"${step}","order":${payload.order},"error":"serialize_failed"}`)
  }
}
