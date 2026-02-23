# op-reth Headers 阶段卡住分析

## 现象

- `stage=Headers checkpoint=42416098 target=None` 长时间不变
- `connected_peers=0` 持续为 0
- op-node 持续通过 Engine API 推送新区块（42,524,xxx）
- 但 backfill pipeline 的 Headers 阶段无推进

## 根因

### 1. Headers 阶段依赖 P2P 下载

根据 reth 文档与源码：

- **Headers 阶段**通过 `HeaderDownloader` 从 **P2P 网络** 拉取历史区块头
- 若 `connected_peers=0`，则无法获取任何 header，阶段无法推进
- `target=None` 表示无法从网络获取链 tip，因此没有同步目标

### 2. 为何 connected_peers=0？

日志显示：

```
enode=enode://...@127.0.0.1:30313?discport=9200
```

**节点对外广播的地址是 127.0.0.1**。其他节点会尝试连接 `127.0.0.1:30313`，即连接到自己本机，而不是你的节点，因此无法建立 P2P 连接。

在 Docker 中运行时，NAT 检测通常失败，会错误使用容器内看到的 127.0.0.1 作为对外地址。

### 3. reth_eth_wire handshake 错误

```
DEBUG reth_eth_wire::handshake: decode error in eth handshake: msg=00f85b45...
```

说明有节点尝试连接，但握手失败。可能原因包括：

- 协议版本或 fork ID 不匹配
- 对方为 op-node（共识层）而非执行层节点，协议不同

### 4. op-node 与 op-reth 的 P2P 是两套网络

- **op-node P2P**（端口 9222）：共识层，用于 op-node 之间同步
- **op-reth P2P**（端口 30313）：执行层，用于 op-reth/op-geth 之间同步 headers/bodies

op-node 的 `--p2p.bootnodes` 只作用于 op-node，**不会**给 op-reth 提供执行层 peer。

## 数据流关系

```
op-node (共识层)                    op-reth (执行层)
     |                                    |
     | Engine API (新区块)                 | P2P (历史 headers/bodies)
     |----------------------------------->| <----- 需要其他 Base 执行节点
     |                                    |
     | 只推送“最新”区块                    | Backfill 需从 P2P 拉历史
```

op-node 通过 Engine API 推送的是**最新区块**，backfill 需要补齐的**历史区块**（42,416,098 → 42,524,xxx）必须从其他 Base 执行节点通过 P2P 下载。

## 解决方案

### 方案 A：修正 NAT/对外地址（推荐）

在 op-reth 启动参数中显式指定公网 IP：

```yaml
# docker-compose-op-reth.yml 中 op-reth 的 command 添加：
- "--nat=extip:38.102.126.30"   # 替换为你的公网 IP
```

这样 enode 会广播正确公网 IP，其他节点才能连上。

### 方案 B：添加 Base 执行层 bootnodes

若 reth 的 `--chain=base` 未内置 bootnodes，可显式指定：

```yaml
- "--bootnodes=enode://87a32fd13bd596b2ffca97020e31aef4ddcc1bbd4b95bb633d16c1329f654f34049ed240a36b449fda5e5225d70fe40bc667f53c304b71f8e68fc9d448690b51@3.231.138.188:30301,enode://ca21ea8f176adb2e229ce2d700830c844af0ea941a1d8152a9513b966fe525e809c3a6c73a2c18a12b74ed6ec4380edf91662778fe0b79f6a591236e49e176f9@184.72.129.189:30301"
```

（以上为 Base mainnet 执行层 bootnodes 示例，需以 Base 官方最新配置为准。）

### 方案 C：使用快照恢复（绕过 backfill）

若从 Base 官方快照恢复，数据已包含到 checkpoint 之后，可减少或避免 backfill，从而不依赖 P2P 拉历史。

### 方案 D：端口与防火墙

确认 30313 (TCP/UDP) 已在防火墙和路由器上开放，以便其他节点可访问。

## 参考

- [paradigmxyz/reth#16168](https://github.com/paradigmxyz/reth/issues/16168) - Slow Peer Discovery on Base Mainnet (op-reth) After Restart
- [reth HeaderDownloader](https://reth.rs/docs/src/reth_stages/stages/headers.rs.html) - Headers 阶段从 P2P 下载
- reth `--nat` 可选值：`any|none|upnp|publicip|extip:<IP>`
