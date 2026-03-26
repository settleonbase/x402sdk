/**
 * Log tiers JSON for POST /api/createCard troubleshooting (Cluster → Master → CCSA).
 *
 * Enable when any of:
 * - BEAMIO_CREATE_CARD_LOG_TIERS=1  (tiers only, minimal noise)
 * - BEAMIO_CREATE_CARD_DEBUG=1
 * - BEAMIO_CREATE_CARD_CHAIN_TRACE=1
 *
 * journalctl: grep BeamioCreateCard:tiers
 */

function shouldLogCreateCardTiersJson(): boolean {
  if (typeof process === 'undefined') return false
  const e = process.env
  return (
    e.BEAMIO_CREATE_CARD_LOG_TIERS === '1' ||
    e.BEAMIO_CREATE_CARD_LOG_TIERS === 'true' ||
    e.BEAMIO_CREATE_CARD_DEBUG === '1' ||
    e.BEAMIO_CREATE_CARD_CHAIN_TRACE === '1'
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  } catch {
    return '"[BeamioCreateCard:tiers safeStringify failed]"'
  }
}

/**
 * @param where Stable label, e.g. cluster.api.createCard.parsedBody.tiers
 * @param tiers Raw tiers from JSON body, or normalized array for chain
 */
export function emitCreateCardTiersJson(where: string, tiers: unknown): void {
  if (!shouldLogCreateCardTiersJson()) return
  console.warn(`[BeamioCreateCard:tiers] where=${where} json=${safeStringify(tiers ?? null)}`)
}
