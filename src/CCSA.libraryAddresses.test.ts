import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	assertBeamioUserCardLinkedDeployedBytecodeFitsEip170,
	resolveBeamioUserCardLibraryAddresses,
} from './CCSA.js'
import { beamioUserCardLibrariesForChain } from './beamioUserCardChain.js'

describe('resolveBeamioUserCardLibraryAddresses', () => {
	it('keeps BeamioUserCardTierOpsLib from the CoNET override map', () => {
		const libs = resolveBeamioUserCardLibraryAddresses(beamioUserCardLibrariesForChain('conet'))
		assert.ok(libs)
		assert.match(libs.BeamioUserCardTierOpsLib, /^0x[0-9a-fA-F]{40}$/)
	})

	it('links current UserCard artifact without missing-address errors', () => {
		const libs = resolveBeamioUserCardLibraryAddresses(beamioUserCardLibrariesForChain('conet'))
		assert.doesNotThrow(() => assertBeamioUserCardLinkedDeployedBytecodeFitsEip170(libs))
	})
})
