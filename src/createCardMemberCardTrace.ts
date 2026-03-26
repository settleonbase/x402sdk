/**
 * Wire-up in full repo `src/MemberCard.ts`:
 * - At start of `createCardPoolPress`, after dequeuing SC + job, call `traceMemberCardCreateCardPoolPressDequeue`.
 * - At start of `createBeamioCardAdminWithHash`, call `traceMemberCardCreateBeamioCardAdminWithHashEnter`.
 * - Immediately before `return createBeamioCardWithFactoryReturningHash(...)` / `return createBeamioCardWithFactory(...)`, call `traceMemberCardDelegateToCCSA`.
 */
import { emitCreateCardChainTrace } from './createCardChainTrace'

export function traceMemberCardCreateCardPoolPressDequeue(payload: {
  admin: string
  cardOwner: string
  currency: string
  priceE6: string
}): void {
  emitCreateCardChainTrace('MemberCard.createCardPoolPress.dequeue', payload)
}

export function traceMemberCardCreateBeamioCardAdminWithHashEnter(payload: {
  cardOwner: string
  currency: string
  priceE6: string
  hasTiers: boolean
}): void {
  emitCreateCardChainTrace('MemberCard.createBeamioCardAdminWithHash.enter', payload)
}

/** Right before delegating to CCSA (same process, same dist bundle). */
export function traceMemberCardDelegateToCCSA(mode: 'createBeamioCardWithFactory' | 'createBeamioCardWithFactoryReturningHash'): void {
  emitCreateCardChainTrace('MemberCard.delegateToCCSA', { mode })
}
