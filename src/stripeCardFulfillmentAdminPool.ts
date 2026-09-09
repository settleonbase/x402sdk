import { ethers } from 'ethers'
import { masterSetup } from './util'

export type StripeCardFulfillmentSigner = {
	address: string
	privateKey: string
}

type SignerSlot = StripeCardFulfillmentSigner & { busy: boolean }

let slots: SignerSlot[] | null = null

function loadSlots(): SignerSlot[] {
	if (slots) return slots

	const setup = masterSetup as {
		initManager?: unknown
		StripeCardFulfillmentAdmin?: unknown
	}
	const configuredKeys = Array.isArray(setup.initManager)
		? setup.initManager.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
		: []
	// Keep the previous single-key configuration as a migration fallback.
	if (configuredKeys.length === 0 && typeof setup.StripeCardFulfillmentAdmin === 'string') {
		configuredKeys.push(setup.StripeCardFulfillmentAdmin)
	}

	const seen = new Set<string>()
	slots = []
	for (const rawPrivateKey of configuredKeys) {
		try {
			const privateKey = rawPrivateKey.trim()
			const address = ethers.getAddress(new ethers.Wallet(privateKey).address)
			const key = address.toLowerCase()
			if (seen.has(key)) continue
			seen.add(key)
			slots.push({ address, privateKey, busy: false })
		} catch {
			// Invalid entries are ignored; configuration diagnostics must not expose keys.
		}
	}
	return slots
}

export function getStripeCardFulfillmentAdminAddresses(): string[] {
	return loadSlots().map(({ address }) => address)
}

export function acquireStripeCardFulfillmentSigner(): StripeCardFulfillmentSigner | null {
	const slot = loadSlots().find((candidate) => !candidate.busy)
	if (!slot) return null
	slot.busy = true
	return { address: slot.address, privateKey: slot.privateKey }
}

export function releaseStripeCardFulfillmentSigner(signer: StripeCardFulfillmentSigner): void {
	const slot = loadSlots().find((candidate) => candidate.address.toLowerCase() === signer.address.toLowerCase())
	if (slot) slot.busy = false
}

export function resetStripeCardFulfillmentAdminPoolForTests(): void {
	slots = null
}
