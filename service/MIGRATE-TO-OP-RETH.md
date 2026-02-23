# 迁移到 op-reth

将 Base RPC 从 op-geth 迁移到 op-reth。op-reth 为 Rust 实现，存储与执行效率更好，Base 官方推荐使用。

## 重要说明

- **数据不兼容**：op-geth 与 op-reth 使用不同存储格式，无法直接迁移数据
- **需新建数据目录**：使用 `/media/sda/base/op-reth`，原 `/media/sda/base/op-geth` 可保留作备份
- **推荐从快照恢复**：可大幅缩短同步时间（从数周降到约 15 小时量级）

## 迁移步骤

### 1. 停止当前节点

```bash
cd /path/to/x402sdk/service
docker compose down
```

### 2. 创建 op-reth 数据目录

```bash
sudo mkdir -p /media/sda/base/op-reth
sudo chown -R 1000:1000 /media/sda/base/op-reth   # 或你运行 docker 的用户
```

### 3. 选择同步方式

#### 方式 A：从 Base 官方快照恢复（推荐）

```bash
cd /tmp
# Pruned（省空间，约数百 GB）
wget -c "https://mainnet-reth-pruned-snapshots.base.org/$(curl -s https://mainnet-reth-pruned-snapshots.base.org/latest)"

# 或 Archive（完整归档，更大）
# wget -c "https://mainnet-reth-archive-snapshots.base.org/$(curl -s https://mainnet-reth-archive-snapshots.base.org/latest)"

# 解压到数据目录（使用绝对路径，文件名以实际下载为准）
tar -I zstd -xvf base-reth-snapshot.tar.zst -C /media/sda/base/op-reth

# 检查解压后的目录结构：reth 要求 chaindata、nodes、segments 等直接在 datadir 下
ls -la /media/sda/base/op-reth/

# 若存在嵌套目录（如 reth/、mainnet/ 等），需将内容上移一层
# 示例：若解压后为 op-reth/reth/chaindata，则执行：
# mv /media/sda/base/op-reth/reth/* /media/sda/base/op-reth/
# rm -rf /media/sda/base/op-reth/reth
# 以实际解压出的子目录名为准
```

#### 方式 B：从头同步

不做任何操作，直接启动，op-reth 将从头同步（耗时会较长）。

### 4. 启动 op-reth 版本

```bash
cd /path/to/x402sdk/service
docker compose -f docker-compose-op-reth.yml up -d
```

**若快照已解压但节点无法识别**：检查 datadir 内是否直接包含 `chaindata`、`nodes`、`segments` 等目录。若这些在子目录（如 `reth/`）内，需先执行 `mv` 上移后再启动。

### 5. 验证

```bash
# 区块高度
curl -s http://127.0.0.1:8547 -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'

# 同步状态
curl -s http://127.0.0.1:8547 -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_syncing","params":[]}'
```

### 6. 回退到 op-geth（如遇问题）

```bash
docker compose -f docker-compose-op-reth.yml down
docker compose up -d    # 使用原 docker-compose.yml
```

## 资源分配（64c + 128G 主机）

| 服务 | CPU | 内存限制 | 内存预留 |
|------|-----|----------|----------|
| op-reth | 56 | 112G | 16G |
| op-node | 8 | 16G | 4G |

若使用 Docker Swarm，可改用 `deploy.resources`；`docker compose up` 使用 `cpus` / `mem_limit` 即可生效。

## 配置对照

| 项目 | op-geth | op-reth |
|------|---------|---------|
| 镜像 | us-docker.pkg.dev/oplabs.../op-geth | ghcr.io/paradigmxyz/op-reth |
| 链配置 | --op-network=base-mainnet | --chain=base |
| 数据目录 | /media/sda/base/op-geth | /media/sda/base/op-reth |
| JWT | 共用 /media/sda/base/jwt | 共用 |
| op-node L2 | http://op-geth:8551 | http://op-reth:8551 |

## 加速配置（已内置）

- **op-reth**：`--engine.parallel-sparse-trie`（并行状态根）、`--rpc.max-connections=600`、`--rpc.gascap` 无上限
- **op-node**：`--l1.max-concurrency=50`、`--l1.cache-size=1500`、`--l1.http-poll-interval=4s`

**完整加速策略**：见 [ACCELERATION-STRATEGY.md](./ACCELERATION-STRATEGY.md)。reth 阶段调优需**直接修改 datadir 内 reth.toml**，勿用 `--config` 挂载（会导致启动卡住）。

## 故障排查

### "failed to notify engine of protocol version" Method not found

op-node 在 `--rollup.load-protocol-versions=true` 时会从 L1 合约加载协议版本并调用 `engine_signalSuperchainV1` 等 Engine API 通知执行层，op-reth 可能未实现该方法。解决：在 op-node 中设置 `--rollup.load-protocol-versions=false`（已在 docker-compose-op-reth.yml 中默认关闭）。

## 参考

- [Base Node 官方仓库](https://github.com/base/node)（含 reth 配置）
- [Base Reth 快照文档](https://docs.base.org/base-chain/node-operators/snapshots)
- [Reth OP Stack 文档](https://reth.rs/run/opstack/)
