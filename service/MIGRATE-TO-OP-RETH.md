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

# 解压到数据目录（文件名以实际下载为准）
tar -I zstd -xvf mainnet-reth-*.tar.zst -C /media/sda/base/op-reth
```

#### 方式 B：从头同步

不做任何操作，直接启动，op-reth 将从头同步（耗时会较长）。

### 4. 启动 op-reth 版本

```bash
docker compose -f docker-compose-op-reth.yml up -d
```

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

## 配置对照

| 项目 | op-geth | op-reth |
|------|---------|---------|
| 镜像 | us-docker.pkg.dev/oplabs.../op-geth | ghcr.io/paradigmxyz/op-reth |
| 链配置 | --op-network=base-mainnet | --chain=base |
| 数据目录 | /media/sda/base/op-geth | /media/sda/base/op-reth |
| JWT | 共用 /media/sda/base/jwt | 共用 |
| op-node L2 | http://op-geth:8551 | http://op-reth:8551 |

## 参考

- [Base Node 官方仓库](https://github.com/base/node)（含 reth 配置）
- [Base Reth 快照文档](https://docs.base.org/base-chain/node-operators/snapshots)
- [Reth OP Stack 文档](https://reth.rs/run/opstack/)
