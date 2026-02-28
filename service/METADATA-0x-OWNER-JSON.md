# 0x{owner}.json 的写入与 endpoint 服务

创建卡时提交的 `shareTokenMetadata`、`tiers`（含 name、description）会写入 **本地文件** `0x{owner}.json`，再由 **Cluster** 用同一目录通过 HTTP 以 endpoint 形式读出并返回。

---

## 1. 谁写：Master 侧（创建卡成功后）

- **文件**：`src/MemberCard.ts` 中的 `createCardPoolPress`
- **时机**：`createBeamioCardAdminWithHash` 上链成功后
- **文件名**：`0x{owner}.json`，其中 `owner = ethers.getAddress(cardOwner)`（创建卡时传入的 cardOwner，即卡的归属地址），小写 40 位 hex：`0x${ownerAddr.slice(2).toLowerCase()}.json`
- **目录**：`METADATA_BASE`，默认 `/home/peter/.data/metadata`，可通过环境变量 `METADATA_BASE` 覆盖
- **路径**：`resolve(METADATA_BASE, metaFilename)` → 例如 `/home/peter/.data/metadata/0x1234...abcd.json`
- **内容**：JSON，包含顶层 `name`、`description`、`image`（供 ERC1155 / 前端），以及 `shareTokenMetadata`、`tiers`（创建卡时 cardManager 提交的 name/description 等）

```ts
// MemberCard.ts 3322-3349
const METADATA_BASE = process.env.METADATA_BASE ?? '/home/peter/.data/metadata'
const metaFilename = `0x${ownerAddr.slice(2).toLowerCase()}.json`
const metaPath = resolve(METADATA_BASE, metaFilename)
// ...
fs.writeFileSync(metaPath, metaContent, 'utf-8')
```

---

## 2. 谁读、谁服务：Cluster 侧（HTTP GET）

- **文件**：`src/endpoint/beamioServer.ts`
- **路由**：`GET /metadata/:filename`（挂在 Express 的 **根** app 上，不是 `/api` 下）
- **目录**：同一 `METADATA_BASE`（默认 `/home/peter/.data/metadata`）
- **逻辑**：
  - 只接受 `filename` 形如 `0x[0-9a-fA-F]{40}.json` 或 `[0-9a-f]{64}.json`，防止路径穿越
  - `filePath = resolve(METADATA_BASE, filename)`，并校验 `filePath` 在 `METADATA_BASE` 下
  - `fs.readFileSync(filePath, 'utf-8')` 读文件，解析 JSON
  - 若是「共享」用法（0x{owner}.json 或 tokenId < ISSUED_NFT_START_ID）：返回 `shareTokenMetadata` 展开内容，并附带 `tiers`（若有）
  - 设置 `Content-Type: application/json`，返回 JSON 字符串

即：**后端通过「从 METADATA_BASE 读出 0x{owner}.json 文件」来服务该 endpoint**，没有单独再建一个“metadata 服务”，就是同一台机上的同一目录，写用 Master、读用 Cluster。

```ts
// beamioServer.ts 1715-1753
const METADATA_BASE = process.env.METADATA_BASE ?? '/home/peter/.data/metadata'
app.get('/metadata/:filename', (req, res) => {
  const filename = req.params.filename  // 例如 "0x1234...abcd.json"
  const filePath = resolve(METADATA_BASE, filename)
  const content = fs.readFileSync(filePath, 'utf-8')
  // 解析、按 shared/tiers 组装 out，再 res.send(JSON.stringify(out))
})
```

---

## 3. 前端 / 链上如何命中该 endpoint

- 卡合约的 `uri` 默认由 `CCSA.ts` 等构建为：`https://api.beamio.io/metadata/0x{owner}.json`
- 前端 `getCardMetadataFromUri(cardAddress)` 会调 `card.uri(0)` 得到该 URL（或带 `{id}` 的模板，替换为 0），再 `fetch(url)`
- 请求即：`GET https://api.beamio.io/metadata/0x{owner}.json` → 若域名指向 Cluster，则由上面 `GET /metadata/:filename` 处理，`filename = 0x{owner}.json`，从 **同一 METADATA_BASE 读出该文件** 并返回

---

## 4. 部署要点

- **Master 与 Cluster 必须对同一 `METADATA_BASE` 可见**：
  - 若在同一台机：都用默认或同一 `METADATA_BASE` 即可；
  - 若 Master 与 Cluster 在不同机器：需要共享存储（如 NFS、共享盘）或由某处把 `0x{owner}.json` 同步到 Cluster 的 `METADATA_BASE`，否则 Cluster 读不到 Master 写的文件。
- 确保 `METADATA_BASE` 目录存在；Master 在写入前有 `if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true })`。
- 对外域名（如 `api.beamio.io`）的 `/metadata/*` 应路由到 Cluster（beamioServer），这样 `GET https://api.beamio.io/metadata/0x{owner}.json` 才会被正确读出并作为 endpoint 返回。

总结：**后端通过「Master 写本地文件 0x{owner}.json，Cluster 从同一 METADATA_BASE 读该文件并在 GET /metadata/:filename 中返回」来把 0x{owner}.json 作为 endpoint 服务。**
