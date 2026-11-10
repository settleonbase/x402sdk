import { handleSetChatIndexPointerHttp, type ChatPointerHttpBody, type ChatPointerHttpResult } from './chatPointerRelayGate'
import { submitIsolatedChatPointer } from './chatPointerIsolatedSend'
import { WalletSignerClient } from './remoteSigner'

export type ChatPointerHttpSink = {
	headersSent: boolean
	status(code: number): { json(payload: unknown): { end(): void } }
}

/**
 * Production isolated branch of POST /setChatIndexPointer.
 * beamioMaster calls this only when settleGasRelay isolation is on.
 * The legacy key reader throws and is not used for a successful or refused call.
 */
export function dispatchIsolatedSetChatIndexPointer(body: ChatPointerHttpBody): Promise<ChatPointerHttpResult> {
	return handleSetChatIndexPointerHttp(body, {
		isolationActive: true,
		lookup: {
			accounts: (keyArray, chainId) => WalletSignerClient.fromEnv().accounts(keyArray, chainId),
		},
		readLegacyKeys: () => {
			throw new Error('chat pointer relay refused a legacy private-key read')
		},
		send: (call) => submitIsolatedChatPointer(call),
	})
}

export function writeIsolatedChatPointerResponse(body: ChatPointerHttpBody, res: ChatPointerHttpSink): void {
	void dispatchIsolatedSetChatIndexPointer(body).then((outcome) => {
		if (outcome.deferred || res.headersSent) return
		res.status(outcome.status).json(outcome.json).end()
	}).catch(() => {
		if (!res.headersSent) {
			res.status(503).json({ success: false, error: 'signer_unavailable', retryable: true }).end()
		}
	})
}
