<div align="center">
  <h1>💸 Settle x402 SDK</h1>
  <p><strong>Gasless USDC transfers on Base using Coinbase's x402 protocol</strong></p>
  <p>Powering the next generation of minting, launchpads, and on-chain settlement experiences</p>

  <p>
    <a href="https://www.npmjs.com/package/@settle402/sdk"><img src="https://img.shields.io/npm/v/@settle402/sdk?color=blue" alt="npm version"></a>
    <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Base-Mainnet-0052FF?logo=coinbase&logoColor=white" alt="Base">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  </p>
</div>

---

## ✨ Features

- **🚫 Gasless Transfers** — Send USDC without paying gas fees
- **🔗 x402 Protocol** — Built on Coinbase's facilitator protocol (Cloudflare-powered)
- **⚡ Simple API** — Developer-friendly TypeScript interfaces
- **🔐 Secure Signing** — Simplified transaction signing flow
- **🌐 Base Network** — Native support for Base mainnet

## 📦 Installation

```bash
npm install @settle402/sdk
# or
yarn add @settle402/sdk
# or
pnpm add @settle402/sdk
```

## 🚀 Quick Start

### Basic Usage

```typescript
import { launchDaemon } from '@settle402/sdk';

// Start the x402 server on port 3001
launchDaemon(3001, './workers');
```

### CLI Usage

```bash
# Run x402 server on custom port
npx x402 --port 3001

# Specify worker files path
npx x402 --path ./workers

# Combined options
npx x402 --port 3001 --path ./workers
```

### Server Integration

```typescript
import { x402Server, verifyBeamioSunUrl, verifyBeamioSunRequest } from '@settle402/sdk';

// Initialize the server
const server = new x402Server(3001, __dirname);

// Verify incoming requests
const isValid = await verifyBeamioSunRequest(request);
```

## 🛠️ API Reference

### `launchDaemon(port, path)`

Starts the x402 daemon server.

| Parameter | Type | Description |
|-----------|------|-------------|
| `port` | `number` | Port to run the server on (default: 3001) |
| `path` | `string` | Path to worker files |

### `verifyBeamioSunUrl(url)`

Verifies a Beamio Sun URL for authenticity.

### `verifyBeamioSunRequest(request)`

Validates an incoming request against the x402 protocol.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│                    Your App                      │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│               Settle x402 SDK                    │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │  x402Server  │  │  Transaction Signing     │ │
│  └──────────────┘  └──────────────────────────┘ │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│        Coinbase x402 Facilitator Protocol        │
│              (Cloudflare-powered)                │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│              Base Network (L2)                   │
│                 USDC Transfers                   │
└─────────────────────────────────────────────────┘
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `X402_PORT` | Server port | `3001` |
| `X402_PATH` | Worker files path | Current directory |

## 📖 Use Cases

- **NFT Minting** — Gasless mint transactions for better UX
- **Launchpads** — Seamless token purchases without gas friction
- **Payments** — Accept USDC payments without gas costs for users
- **Settlement** — On-chain settlement for off-chain transactions

## 🔗 Dependencies

- [`@coinbase/x402`](https://www.npmjs.com/package/@coinbase/x402) — Coinbase x402 protocol
- [`@coinbase/cdp-sdk`](https://www.npmjs.com/package/@coinbase/cdp-sdk) — Coinbase Developer Platform SDK
- [`viem`](https://viem.sh) — TypeScript Ethereum interface
- [`ethers`](https://ethers.org) — Ethereum utilities

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT License — see the [LICENSE](LICENSE) file for details.

## 🔗 Resources

- [Coinbase x402 Protocol](https://docs.cdp.coinbase.com/x402/)
- [Base Network](https://base.org)
- [USDC on Base](https://www.circle.com/usdc)

---

<p align="center">
  <sub>📄 README optimized with <a href="https://gingiris.github.io/github-readme-generator/">Gingiris README Generator</a></sub>
</p>
