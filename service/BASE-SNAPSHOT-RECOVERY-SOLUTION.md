# Base 快照恢复问题：调查与解决方案

## 问题现象

- op-node 能完成回溯并进入 Advancing
- op-reth 区块高度停在约 42,528,073，不再增长
- op-reth 只收到 Forkchoice，未收到 newPayload

## 根本原因

| 项目 | 当前配置 | Base 官方 |
|------|----------|-----------|
| 执行层 | `paradigmxyz/op-reth:v1.10.2` | `base-reth-node`（base/base 仓库） |
| 快照来源 | Base 官方 mainnet-reth-pruned-snapshots | 同源，由 base-reth-node 生成 |
| 快照兼容性 | **不匹配** | 完全匹配 |

Base 官方快照由 **base-reth-node** 生成，而当前使用的是 **op-reth**（OP Labs 的 fork）。两者虽同属 reth 系，但 Base 对 base-reth 有定制（如 Flashblocks），快照格式与内部结构可能与 op-reth 不完全兼容。

---

## 解决方案

### 方案 A：改用 Base 官方 node 仓库（推荐）

使用 Base 官方的 base-reth-node，与快照完全兼容。

#### 步骤

1. **克隆 Base 官方 node 仓库**

```bash
cd /home/peter/base
git clone https://github.com/base-org/node.git base-node
cd base-node
```

2. **配置环境**

```bash
cp .env.mainnet .env
# 编辑 .env，设置 L1 端点：
# OP_NODE_L1_ETH_RPC=http://host.docker.internal:8545
# OP_NODE_L1_BEACON=http://host.docker.internal:5052
# OP_NODE_L1_BEACON_ARCHIVER=https://ethereum-beacon-api.publicnode.com
```

3. **准备快照数据目录**

```bash
# 数据目录需与 docker-compose 中的 HOST_DATA_DIR 一致
export HOST_DATA_DIR=/home/peter/base/reth-data
mkdir -p $HOST_DATA_DIR
```

4. **下载并解压快照**

```bash
cd /home/peter/base
wget -c "https://mainnet-reth-pruned-snapshots.base.org/$(curl -s https://mainnet-reth-pruned-snapshots.base.org/latest)" -O base-reth-snapshot.tar.zst
tar -I zstd -xvf base-reth-snapshot.tar.zst
```

5. **按实际解压结果移动数据**

```bash
# 若解压得到 reth/ 目录：
mv ./reth/* $HOST_DATA_DIR/
rm -rf ./reth

# 若解压得到 snapshots/mainnet/download/ 等：
# 将 db 和 static_files 移到 $HOST_DATA_DIR 根目录
# 目标：chaindata、nodes、segments、static_files 等直接在 $HOST_DATA_DIR 下
```

6. **启动节点**

```bash
cd base-node
CLIENT=reth HOST_DATA_DIR=/home/peter/base/reth-data docker compose up --build
```

> **端口冲突**：Base 官方 compose 默认 RPC 8545、WS 8546。若宿主机 8545 已被 L1 占用，需修改 `docker-compose.yml` 的端口映射，例如将 execution 的 `8545:8545` 改为 `8547:8545`。

---

### 方案 B：在现有 compose 中尝试 execution-layer 同步

若希望继续使用 op-reth，可先尝试改为 execution-layer，由 reth 自行 P2P 同步，不依赖 op-node 的 newPayload。

**修改**：将 op-node 的 `--syncmode=consensus-layer` 改为 `--syncmode=execution-layer`。

**快速使用**：已提供 compose 覆盖文件 `docker-compose-op-reth-home-execution-layer.yml`，执行：

```bash
docker compose -f docker-compose-op-reth-home.yml -f docker-compose-op-reth-home-execution-layer.yml up -d
```

- 优点：无需换镜像，改动小
- 缺点：op-reth 需能发现 Base L2 peers（discv5 端口 9200 已映射），若快照本身不兼容，可能仍无法同步

---

### 方案 C：验证快照目录结构后重试

确保快照解压后目录结构正确，避免 reth 无法识别数据。

**正确结构**（datadir 根目录下应有）：

```
/home/peter/base/op-reth/
├── db/           # 或 chaindata、mainnet/db 等（视 reth 版本）
├── static_files/
├── nodes/
├── segments/
└── ...
```

若解压得到 `snapshots/mainnet/download/db`，需执行：

```bash
mv snapshots/mainnet/download/db /home/peter/base/op-reth/
mv snapshots/mainnet/download/static_files /home/peter/base/op-reth/
# 其他子目录同理
```

---

### 方案 D：使用 Base 预构建 node-reth 镜像（实验性）

若存在 `ghcr.io/base/node-reth` 的 standalone 镜像，可尝试替换 op-reth。该镜像通常随 base-org/node 一起使用，单独使用需自行适配 entrypoint 和参数。

```bash
docker pull ghcr.io/base/node-reth:latest
```

需确认该镜像的默认命令、环境变量（如 `RETH_CHAIN`、`RETH_SEQUENCER_HTTP`）及与 op-node 的 Engine API 对接方式。

---

## 推荐执行顺序

1. **优先方案 A**：使用 Base 官方 node + base-reth-node，与快照完全兼容。
2. 若必须保留当前架构，可先试 **方案 B**（execution-layer）。
3. 同时做 **方案 C**，确认快照目录无误。
4. 方案 D 作为备选，需额外验证镜像用法。

---

## 快照下载命令（固定版本可选）

若需固定快照版本（避免 `latest` 变化）：

```bash
# 查看当前 latest 指向
curl -s https://mainnet-reth-pruned-snapshots.base.org/latest

# 下载指定文件（替换为实际文件名）
wget -c "https://mainnet-reth-pruned-snapshots.base.org/<filename>.tar.zst" -O base-reth-snapshot.tar.zst
```

---

## 参考

- [Base Node Operators - Snapshots](https://docs.base.org/base-chain/node-operators/snapshots)
- [Base Node - GitHub](https://github.com/base-org/node)
- [Base Run a Node](https://docs.base.org/base-chain/node-operators/run-a-base-node)
