# Base RPC 循环重试修复手册（38.102.126.30）

目标：快速验证并止血 `payload job 重试 + Long-lived read transaction` 循环。

## 已落地的配置修复

已将 `docker-compose-op-reth.yml`（以及回退用 `docker-compose.yml`）中的执行层端口改为仅本机绑定：

- `127.0.0.1:8547:8545`
- `127.0.0.1:8548:8546`
- `127.0.0.1:8552:8551`

这会阻止公网直接访问 op-reth，外部流量必须经本机反向代理入口。

## 10 分钟最小化验证（推荐）

以下命令在服务器 `38.102.126.30` 上执行。

### 1) 仅启动 op-reth（先不启动 op-node）

```bash
cd /path/to/x402sdk/service
docker compose -f docker-compose-op-reth.yml down
docker compose -f docker-compose-op-reth.yml up -d op-reth
```

### 2) 核对 8547 已不再对公网监听

```bash
ss -ltnp | rg "8547|8548|8552"
```

预期：看到 `127.0.0.1:8547`、`127.0.0.1:8548`、`127.0.0.1:8552`，而不是 `0.0.0.0:*`。

### 3) 观察 3-5 分钟 op-reth 日志

```bash
docker logs --since=5m base-op-reth 2>&1 | rg -i "Long-lived read transaction|payload|timeout|WARN|ERROR"
```

若外部查询压力是主因，`Long-lived read transaction ... open_duration=300s` 的频率应明显下降。

### 4) 再启动 op-node，观察 payload 是否恢复推进

```bash
docker compose -f docker-compose-op-reth.yml up -d op-node
docker logs --since=5m base-op-node 2>&1 | rg -i "payload|forkchoice|engine|error|warn"
```

## 对外服务建议

- 对外统一走 `nginx -> 127.0.0.1:8547`，不要再直接暴露 `8547`。
- 若仍需公网 RPC，建议在代理层增加速率限制和方法级白名单（至少限制高成本查询）。
- 生产环境建议把 `8552` 仅保留本机使用，避免 Engine API 被误暴露。

## 回滚

若需要临时回滚，恢复 compose 端口映射为 `8547:8545` 等并重启容器：

```bash
docker compose -f docker-compose-op-reth.yml down
docker compose -f docker-compose-op-reth.yml up -d
```

