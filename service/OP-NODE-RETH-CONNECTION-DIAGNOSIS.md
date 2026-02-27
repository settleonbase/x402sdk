# op-node 与 reth 连接问题诊断

## 检查是否已进入 Engine Queue

在服务器上执行诊断脚本：

```bash
cd /path/to/service
chmod +x check-op-node-engine-queue.sh
./check-op-node-engine-queue.sh
```

若在远程执行，需先做 SSH 端口转发或设置 RPC 地址：

```bash
OP_NODE_RPC=http://服务器IP:8549 RETH_RPC=http://服务器IP:8547 ./check-op-node-engine-queue.sh
```

脚本会输出：
- `current_l1`：当前回溯到的 L1 区块
- `unsafe_l2.l1origin`：目标 L1 区块（reth 链头对应的 L1）
- 预计剩余 L1 区块数与时间

---

## 现象

- **op-node**：持续 "Walking back L1Block by hash"，L1≈24513884，L2≈42495936
- **reth**：持续报错 `Post-merge network, but never seen beacon client. Please launch one to follow the chain!`
- **结论**：op-node 尚未向 reth 发送任何 Engine API 请求

---

## 原因分析

### 1. op-node 的 sync 流程

| 阶段 | 行为 | 是否联系 reth |
|------|------|---------------|
| **Walking back** | 沿 L1 区块哈希回溯，寻找正确的 L1 起点 | **否** |
| **Engine Queue** | 派生 L2 区块，发送 Forkchoice / newPayload | **是** |

在 consensus-layer 模式下，op-node 会先完成 L1 回溯，**之后**才会进入 Engine Queue 并调用 reth 的 Engine API。  
因此，只要 op-node 一直处于 Walking back，reth 就不会收到任何 Engine API 请求，从而持续报 "never seen beacon client"。

### 2. 为何 Walking back 可能很慢或卡住

- 回溯从当前 L1 头开始，逐块向创世方向走
- 需要找到与 reth 当前 L2 链头对应的 L1 区块
- 若快照对应的 L2 高度较高（如 ~42M），对应 L1 区块可能距离当前头较远
- 每步都要拉取 L1 数据并验证，回溯大量区块会非常耗时

### 3. 其他可能原因

- **网络**：op-node 无法访问 `op-reth:8551`
- **JWT**：JWT 不匹配导致 Engine API 请求被拒绝（但此时 reth 通常仍会“看到”请求，只是返回错误）
- **协议**：Base 官方使用 `ws://`，当前使用 `http://`，可能存在实现差异

---

## 诊断步骤

### 1. 检查 op-node 能否访问 reth Engine API

在宿主机执行：

```bash
# 进入 op-node 容器
docker exec -it base-op-node sh

# 测试能否连上 reth Engine API（无 JWT 应返回 401）
wget -qO- --header "Content-Type: application/json" \
  --post-data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://op-reth:8551

# 期望：401 Unauthorized 或类似，说明 8551 可达
# 若连接超时/失败，说明网络或 DNS 有问题
exit
```

### 2. 检查 JWT 是否一致

```bash
# 宿主机
md5sum /home/peter/base/jwt/jwt.hex
# op-node 和 op-reth 挂载的是同一目录，应相同
```

### 3. 尝试改用 WebSocket（与 Base 官方一致）

Base 官方使用 `ws://execution:8551`。可将 op-node 的 `--l2` 改为：

```
--l2=ws://op-reth:8551
```

---

## 修复建议

### 方案 1：改用 ws://（优先尝试）

在 `docker-compose-op-reth-home.yml` 中，将：

```yaml
- "--l2=http://op-reth:8551"
```

改为：

```yaml
- "--l2=ws://op-reth:8551"
```

### 方案 2：改用 execution-layer 同步

让 reth 自行 P2P 同步，不依赖 op-node 的 newPayload：

```bash
docker compose -f docker-compose-op-reth-home.yml \
  -f docker-compose-op-reth-home-execution-layer.yml up -d
```

### 方案 3：耐心等待 Walking back 完成

若网络和 JWT 正常，Walking back 可能只是耗时较长。可观察：

- op-node 日志中 L1 区块号是否持续递减
- 若持续递减，说明在正常回溯，可继续等待

### 方案 4：检查 L1 数据质量

op-node 依赖 L1 RPC 和 Beacon。若 L1 数据不完整或延迟大，回溯会变慢或出错：

- 确认 `host.docker.internal:8545` 和 `:5052` 可访问且已同步
- 检查 L1 节点日志是否有错误或限流

---

## 关于 "Bad discv5 packet"

`err="invalid packet header"` 通常来自其他网络（如以太坊主网）的节点连到你的 discv5 端口 9222。  
这些包格式不兼容，会被丢弃，一般不影响 Base L2 同步，可暂时忽略。

---

## 关于 "failed to serve p2p sync request"

`peer requested unknown block by number: not found` 表示其他节点请求的区块（如 42648675）你尚未同步到。  
当前 L2 约 42499k，无法提供更高区块是正常现象，可忽略。
