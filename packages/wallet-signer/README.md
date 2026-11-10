# wallet-signer

Sign-only key service for CoNET daemons. One password-protected 24-word mnemonic; keys are
derived per **key array name** (the field names of `master.json`) and remembered in a signed
registry, so a reboot gives the same addresses. Daemons never see private keys: they ask the
service, over mTLS JSON-RPC, to sign or send a transaction with "a key of array X", and the
service checks a per-client whitelist (contract × method × arguments), rate limits, manages
nonces, broadcasts, and writes a hash-chained audit log. A gas keeper tops up every array key
from the PM key.

Design: `wallet-signer-design-v0.1.md` (PM notes). This README covers build, operation and
integration. Host names, IPs and SSH details live in the private ops notes, not here.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | service entry (`wallet-signer --config /etc/wallet-signer/config.json`) |
| `src/wsctl.ts` | admin CLI over the local admin socket |
| `src/vault.ts` / `hd.ts` | keystore v3 + scrypt vault, BIP-44 derivation (@scure, wipeable bytes) |
| `src/registry.ts` | key arrays → accounts → addresses, EIP-712 attestation |
| `src/policy.ts` | client whitelist |
| `src/txManager.ts` | nonce, fees, simulation, broadcast, re-price, idempotency journal |
| `src/gasKeeper.ts` | PM → array keys top-up with daily caps |
| `src/rpcServer.ts` | listeners: behind nginx (trusted identity headers), direct TLS with client certificate, local unix sockets |
| `p0/p0Plan.ts` | role-replacement plan for every contract role held by a leaked key, CoNET and Base (plan / unsigned / fork-run) |
| `deploy/` | systemd unit, nginx front (`nginx-dle.conf`), example config / policy / compromised list |
| `test/` | unit tests, nginx-front integration (`proxy.ts`), end-to-end on an anvil fork |
| `../../src/walletSigner/remoteSigner.ts` | client: `RemoteSigner` (ethers v6), transport, pool |

## Key layout

| Path | Use |
|---|---|
| `m/44'/60'/0'/0/0` | PM key: gas source, the user sends CNET here. Never usable by clients. |
| `m/44'/60'/1'/0/0` | registry attestor; never holds funds |
| `m/44'/60'/2..9'` | reserved |
| `m/44'/60'/{10+}'/0/{i}` | one hardened account per key array, in creation order; indexes only grow |

`wsctl array rotate <name>` gives a name a fresh account and retires the old one (kept loaded so
balances can be swept back).

The vault file is standard Web3 Secret Storage v3 with the ethers mnemonic extension, so a
recovery drill on any machine is `ethers.Wallet.fromEncryptedJson(json, password)` → it yields
the PM key (`m/44'/60'/0'/0/0`). `wsctl verify-vault` does the same offline.

## Client API (JSON-RPC 2.0, `POST /rpc`)

Client identity = CN of its client certificate, signed by the private client CA. Optional second
factor: `tokenSha256` in policy and `Authorization: Bearer <token>`.

Two ways to listen (`rpc` in config.json):

- **Behind nginx (`rpc.proxied`, recommended).** nginx serves the public (Let's Encrypt)
  certificate, requires a client certificate (`ssl_verify_client on`, no certificate → 400), and
  forwards `POST /rpc` to a local unix socket with `X-WS-Client-CN` / `X-WS-Client-Verify`
  (`deploy/nginx-dle.conf`). wallet-signer trusts these headers **only** on that socket, needs
  exactly one value each and `Verify: SUCCESS`, and refuses unknown `X-WS-*` headers. On every
  other listener any `X-WS-*` header is refused (400, audited as `forged_proxy_header`). A
  loopback TCP fallback (`host` 127.0.0.1, `port`) exists but then needs `secretSha256` of an
  `X-WS-Proxy-Auth` value nginx adds. The admin socket is never behind nginx.
- **Direct TLS (`rpc.tls`).** wallet-signer terminates TLS itself; a handshake without a client
  certificate from `rpc.tls.ca` fails before HTTP. Needs `CAP_NET_BIND_SERVICE` for :443
  (`deploy/config.direct-tls.example.json`).

Data paths: `dataDir` (vault, registry, state) and `logDir` (audit log, tx journal; defaults to
`dataDir`). With `requireMountPoint` set, the daemon and `wsctl init` refuse to run unless that
path is a mounted filesystem and both directories are inside it, so nothing is written to the root
disk when the encrypted volume is not open. `"mode": 432` in JSON is `0660`.

| Method | Params | Notes |
|---|---|---|
| `signer_status` | – | state, arrays this client may use, compromised list |
| `signer_accounts` | `{keyArray, chainId?}` | addresses; works while locked |
| `signer_sendTransaction` | `{keyArray, chainId, to, data, value?, gasLimit?, from?, idempotencyKey?}` | managed: simulate, nonce, fees, sign, broadcast; returns `{hash, from, nonce, raw}` |
| `signer_getTransaction` | `{idempotencyKey}` or `{hash}` | final hash after re-pricing, status |
| `eth_signTypedData_v4` | `[address, typedData]` | needs a `typedData` rule (chainId, verifyingContract, primaryType) |
| `eth_signTransaction` | `[tx]` | only with `allowSignOnly`; caller owns the nonce |
| `personal_sign` | `[hexMessage, address]` | only with `allowPersonalSign` |
| `eth_sign` | – | always refused |

Error codes (`src/errors.ts`): `-32001 LOCKED`, `-32003 POLICY_DENIED`, `-32004 RATE_LIMITED`,
`-32005 NO_IDLE_KEY`, `-32006 GAS_PRICE_TOO_HIGH`, `-32007 EXECUTION_REVERTED` (simulation, nothing
sent), `-32010 REGISTRY_MISMATCH`, `-32011 UPSTREAM`. Locked / busy / rate / upstream are
retryable with the same idempotency key. A key whose last attempt reverted may be retried.

Hard rules (not configurable): PM key is never offered to clients; no value transfers to
compromised addresses; value defaults to 0; contract creation refused; `eth_sign` refused.

## Daemon integration

```ts
import { RemoteSigner, WalletSignerClient } from './walletSigner/remoteSigner'
const client = WalletSignerClient.fromEnv()
const signer = new RemoteSigner(client, { keyArray: 'epochManagre', chainId: 224422 }, provider)
const c = new ethers.Contract(addr, abi, signer.withIdempotencyKey(`epoch:${n}`))
await (await c.updateInfo(a, b, d, { gasLimit: 200_000n })).wait()
```

Env: `WALLET_SIGNER_URL`, `WALLET_SIGNER_CERT`, `WALLET_SIGNER_KEY`, optional
`WALLET_SIGNER_CA` (only for a private server CA; unset = Node's public root store, e.g. Let's
Encrypt behind nginx; server verification is always on), `WALLET_SIGNER_TOKEN_FILE`,
`WALLET_SIGNER_SERVERNAME`, and
`WALLET_SIGNER_FEATURES` (comma list) to switch features one at a time:

| Feature | Repo / file | Key array | Rollback |
|---|---|---|---|
| `chat` | x402sdk `src/chatIndexPointer.ts` | `settle_contractAdmin` | drop `chat` from the list |
| `gbAirdrop` | x402sdk `src/gbDepinAirdrop.ts` | `gbDepinAirdropAdmin` | drop `gbAirdrop` |
| `epoch` | CoNET-DL `src/endpoint/epochWriter.ts` | `epochManagre` | drop `epoch` |
| `settle` | x402sdk `src/settleContractPool.ts` (every settle-pool user: MemberCard, redeem, treasury relay, …) | `settle_contractAdmin` (`WALLET_SIGNER_SETTLE_ARRAY`) | drop `settle` (the legacy pool reads `master.json` again) |

`chat` in signer mode answers 503 `signer_unavailable` (not cached) when the signer is locked or
unreachable. `gbAirdrop` and `epoch` reconcile roles at start and every 10 minutes: no grant →
`WAITING_FOR_GRANT` (no writes, the grant plan is logged); epoch removes compromised admins itself.
`settle` reads no private key: the roster is the signer's `settle_contractAdmin` addresses (Base
calls need a Base grant for the same array); until the signer answers the pool is empty and callers
see "busy". Its policy must list every contract and selector the settle pool calls, plus the EIP-712
domains it signs (`executeForAdmin` etc.). The relayer seats those keys need on chain are P5 grants
in `p0Plan` (`--settle-new`).

## Admin (`wsctl`, on the signer host, group `wsadmin`)

```
wsctl init                       # 24 words shown once on the TTY, 3-word check, password twice
wsctl status | unlock | lock
wsctl array add settle_contractAdmin --count 4 --chains 224422
wsctl array add epochManagre --count 1 --chains 224422
wsctl array add gbDepinAirdropAdmin --count 1 --chains 224422
wsctl gas status | gas run | tx list | compromised
wsctl policy reload              # after editing /etc/wallet-signer/policy.json
wsctl client disable <cn>        # cut one daemon off immediately
wsctl verify-vault               # offline recovery drill
```

Passwords and words are read from `/dev/tty` with echo off. `--password-stdin` exists for tests.

## Build and test

```
npm ci && npm run build
npm run test:unit
# nginx front (local only, needs nginx + openssl on PATH; no chain):
X402_BUILD=<x402sdk outDir> NODE_PATH=<x402sdk>/node_modules NGINX=$(which nginx) node dist/test/proxy.js
# e2e (local only): anvil --fork-url https://publicrpc.conet.network --port 18545 --chain-id 224422
E2E_DIR=$(mktemp -d) FORK_RPC=http://127.0.0.1:18545 X402_BUILD=<x402sdk outDir> \
  DL_BUILD=<CoNET-DL outDir> NODE_PATH=<x402sdk>/node_modules node dist/test/e2e.js
```

## P0 role replacement

`node dist/p0/p0Plan.js plan --cold <COLD> --epoch-new <epochManagre[0]> --airdrop-new <gbDepinAirdropAdmin[0]>`
prints every step (signer, contract, call, calldata, gas). `unsigned` writes unsigned txs for
the key-rotation session to sign offline; `fork-run` rehearses all steps on a local anvil fork.
The script never holds keys and never broadcasts to a public network.

AddressPGP (chat public-key directory, `0x684b…f9e2`) is included: it has no owner and a flat
`adminList` where any admin can add or remove any admin. P0 adds COLD and removes the four
settle keys; P5 (`--through p5`, the default) removes the registration wallets in the order the
API migration allows. Until P5 is done, any remaining leaked admin can remove COLD again, so
`plan` prints the current `adminList` state of every known admin (`addressPgpAdminList`).
