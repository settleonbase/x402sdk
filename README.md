# Settle x402 SDK


> TypeScript SDK for seamless **gasless USDC transfers** on **Base** using **Coinbase’s x402 protocol**.  
> Powering the next generation of minting, launchpads, and on-chain settlement experiences.


The Settle x402 SDK provides developers with an easy and secure way to send gasless USDC transactions on the Base network using the x402 facilitator protocol (powered by Coinbase Cloudflare).

## NFC security gate

All NFC top-up, charge, points, asset, and linking routes must pass the shared
server-side `src/nfcSecurityGate.ts` before continuing. The gate validates the
14-hex UID and SUN fields, verifies and persists the SUN counter atomically,
resolves the NFC tag's linked EOA, and optionally checks the POS admin gate.
Routes that provision an unlinked tag may use `allowUnlinked: true`, but must
perform the linked-wallet and POS authorization checks before continuing.
Callers must not run `verifyAndPersistBeamioSunUrl` a second time for the same
request: doing so can consume the SUN counter and cause a valid request to be
rejected as a replay.

It is built to simplify complex on-chain settlement flows:

Gasless USDC transfers

x402 facilitator integration

Simplified transaction signing

Developer-friendly APIs

---

## Installation

```bash
npm i @settle402/sdk
# or
yarn add @settle402/sdk