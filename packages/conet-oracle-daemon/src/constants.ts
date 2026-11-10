/** CoNET L1. Base (8453) is refused. */
export const CONET_CHAIN_ID = 224422

/** BeamioOracle on CoNET. Native value sent here must be zero. */
export const BEAMIO_ORACLE = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008'

/** Quote-signing owner. The gas keeper may fund this wallet. This daemon does not. */
export const ORACLE_OWNER = '0xccB259772944c1c8Ff9b3F877cD81519c33063EE'

/** Old GuardianOracle on CoNET. Never a quote target. */
export const GUARDIAN_ORACLE_CONET = '0xE9922F900Eef37635aF06e87708545ffD9C3aa99'

/** Old oracle address used by the Base half of the retired dual-write process. */
export const GUARDIAN_ORACLE_BASE = '0xDa4AE8301262BdAaf1bb68EC91259E6C512A9A2B'

export const ORACLE_CLIENT_NAME = 'oracle-daemon'

export const ORACLE_SOCKET_PATH = '/run/wallet-signer-oracle/oracle-daemon.sock'

export const ORACLE_KEY_ARRAY = 'beamio_oracle_owner'

/** Two 10-minute timer intervals. Older HTTP Date headers are not signed. */
export const MAX_SOURCE_AGE_MS = 20 * 60 * 1000

/** Public Coinbase FX. No API key. USD per foreign unit is 1 / data.rates[CCY]. */
export const COINBASE_FX_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=USD'

/** Public Coinbase ETH-USD spot. data.amount is USD per 1 ETH. */
export const COINBASE_ETH_USD_SPOT_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot'

/** Fresh HTTP attempts per oneshot. A locked signer is not retried inside this bound. */
export const MAX_FETCH_ATTEMPTS = 3

export const FETCH_TIMEOUT_MS = 10_000

export const UPDATE_RATES_BATCH_SELECTOR = '0x0936c703'

export const UPDATE_RATE_SELECTOR = '0x3c766394'

/** wallet-signer JSON-RPC: vault is locked. Nothing was signed. */
export const SIGNER_LOCKED = -32001
