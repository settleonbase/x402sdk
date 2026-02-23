# op-reth + op-node 加速策略（64c / 128G）

针对 **64 CPU、128GB 内存** 主机，优化 Base L2 节点（op-reth + op-node）同步与运行性能。

## 一、资源分配

| 服务 | CPU | 内存限制 | 内存预留 | 说明 |
|------|-----|----------|----------|------|
| op-reth | 56 | 112G | 16G | 主负载，执行层同步与 RPC |
| op-node | 8 | 16G | 4G | 共识层，L1 数据拉取与派生 |
| 系统预留 | - | ~16G | - | OS、Docker、其他进程 |

**原则**：op-reth 承担区块执行、状态根计算、RPC 等重负载，分配绝大部分资源；op-node 以 L1 RPC 调用为主，8c/16G 足够。

---

## 二、op-reth 加速配置

### 2.1 命令行参数（docker-compose-op-reth.yml）

| 参数 | 值 | 作用 |
|------|-----|------|
| `--engine.parallel-sparse-trie` | - | 并行计算稀疏 trie 状态根 |
| `--rpc.max-connections` | 600 | 提高 RPC 并发连接数 |
| `--rpc.gascap` | 18446744073709551615 | 无上限 gas 估算 |
| `--max-outbound-peers` | 100 | 更多 P2P 对等节点 |

### 2.2 reth.toml 阶段调优

**勿**使用 `--config` 挂载外部 reth.toml（会导致 op-reth 卡在 StaticFileProducer）。应**直接修改 datadir 内** `/media/sda/base/op-reth/reth.toml`：

```bash
# 备份后修改
sudo cp /media/sda/base/op-reth/reth.toml /media/sda/base/op-reth/reth.toml.bak
sudo sed -i 's/downloader_max_concurrent_requests = 100/downloader_max_concurrent_requests = 200/' /media/sda/base/op-reth/reth.toml
sudo sed -i 's/downloader_min_concurrent_requests = 5/downloader_min_concurrent_requests = 20/' /media/sda/base/op-reth/reth.toml
sudo sed -i 's/downloader_max_buffered_responses = 100/downloader_max_buffered_responses = 200/' /media/sda/base/op-reth/reth.toml
sudo sed -i 's/downloader_request_limit = 1000/downloader_request_limit = 2000/' /media/sda/base/op-reth/reth.toml
# bodies
sudo sed -i 's/downloader_request_limit = 200/downloader_request_limit = 400/' /media/sda/base/op-reth/reth.toml
sudo sed -i 's/downloader_max_concurrent_requests = 100/downloader_max_concurrent_requests = 200/' /media/sda/base/op-reth/reth.toml
sudo sed -i 's/downloader_min_concurrent_requests = 5/downloader_min_concurrent_requests = 20/' /media/sda/base/op-reth/reth.toml

# Merkle 阶段（加速 MerkleChangeSets，64c/128G 可提高）
sudo sed -i 's/incremental_threshold = 7000/incremental_threshold = 20000/' /media/sda/base/op-reth/reth.toml
sudo sed -i 's/rebuild_threshold = 100000/rebuild_threshold = 200000/' /media/sda/base/op-reth/reth.toml
```

**Headers 阶段**（加速 header 下载）：
- `downloader_max_concurrent_requests`: 200（默认 100）
- `downloader_min_concurrent_requests`: 20（默认 5）
- `downloader_max_buffered_responses`: 200（默认 100）
- `downloader_request_limit`: 2000（默认 1000）
- `commit_threshold`: 20000（默认 10000）

**Bodies 阶段**（加速 block body 下载）：
- `downloader_request_limit`: 400（默认 200）
- `downloader_max_concurrent_requests`: 200（默认 100）
- `downloader_max_buffered_blocks_size_bytes`: 4GB（默认 2GB）
- `downloader_stream_batch_size`: 2000（默认 1000）

**Peers**：
- `max_concurrent_outbound_dials`: 30（默认 15）

**Sessions**：
- `session_command_buffer`: 64（默认 32）
- `session_event_buffer`: 512（默认 260）

---

## 三、op-node 加速配置

| 参数 | 值 | 说明 |
|------|-----|------|
| `--l1.max-concurrency` | 50 | L1 RPC 并发请求数（默认 10） |
| `--l1.cache-size` | 1500 | L1 块/收据缓存（默认 900，约 3 小时） |
| `--l1.http-poll-interval` | 4s | L1 轮询间隔（更短 = 更快感知新区块） |
| `--l1.beacon.fetch-all-sidecars` | true | 拉取所有 blob sidecars |
| `--verifier.l1-confs` | 4 | L1 确认数 |

**注意**：`l1.cache-size` 越大内存占用越高；1500 在 16G 内可接受。若 L1 RPC 限流，可适当降低 `l1.max-concurrency`。

---

## 四、I/O 与存储建议

1. **数据目录**：使用 SSD/NVMe（如 `/media/sda/base/op-reth`），避免 HDD
2. **文件系统**：推荐 XFS 或 ext4，`noatime` 挂载减少元数据写入
3. **磁盘空间**：Pruned 约数百 GB，Archive 更大；确保至少 500GB 可用

---

## 五、部署步骤

1. **启动**（reth-accel.toml 已自动挂载）：
   ```bash
   docker compose -f docker-compose-op-reth.yml up -d
   ```

2. **验证**：
   ```bash
   # 区块高度
   curl -s http://127.0.0.1:8547 -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
   # 同步状态
   curl -s http://127.0.0.1:8547 -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_syncing","params":[]}'
   ```

---

## 六、监控与调优

- **op-reth**：若 CPU 长期 < 80%，可尝试进一步提高 `downloader_max_concurrent_requests`；若内存接近上限，可降低 `downloader_max_buffered_blocks_size_bytes`
- **op-node**：关注 `op_node_default_rpc_client_request_duration_seconds`，若 L1 RPC 延迟高，可适当降低 `l1.max-concurrency`
- **快照恢复**：若从头同步过慢，优先使用 [Base 官方快照](https://docs.base.org/base-chain/node-operators/snapshots) 恢复

---

## 七、参考

- [Reth 配置文档](https://reth.rs/run/configuration/)
- [op-node 配置参考](https://docs.optimism.io/node-operators/reference/op-node-config)
- [MIGRATE-TO-OP-RETH.md](./MIGRATE-TO-OP-RETH.md)
