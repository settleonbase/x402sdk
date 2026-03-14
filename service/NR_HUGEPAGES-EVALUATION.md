# vm.nr_hugepages 评估

## 本机数据 (38.102.126.30)

| 项目 | 值 |
|------|-----|
| 总 RAM | 125 GB |
| MemAvailable | ~102 GB |
| buff/cache | ~101 GB (可回收) |

### 服务内存占用 (RSS)

| 服务 | 占用 | 说明 |
|------|------|------|
| op-reth | ~76 GB | L2 执行层，最大消费者 |
| geth | ~2.5 GB + 32 GB cache | --cache=32768 |
| lighthouse | ~5 GB | L1 共识 |
| op-node | 20 GB limit | Docker |

### 应用层 huge page 支持

| 应用 | 支持 | 说明 |
|------|------|------|
| op-reth | 否 | 无 --huge 相关参数 |
| geth | 否 | 无 huge 相关参数 |
| Postgres | - | 未运行 |

---

## 结论

**建议：不配置 vm.nr_hugepages，保持默认 0。**

### 理由

1. **无消费者**：op-reth、geth 均不支持显式申请 HugeTLB，Postgres 未运行。
2. **nr_hugepages 会预占内存**：设置的 2MB 页会被内核预留，无法被其他进程使用。
3. **THP 已关闭**：已用 disable-thp 关闭透明大页，避免 THP 带来的延迟抖动。
4. **当前内存压力**：node1 仅剩 83 MB 空闲，node3 约 427 MB，再预留 huge pages 会进一步挤压可用内存。

### 若未来引入 Postgres

可按 `shared_buffers` 估算：

```
nr_hugepages = shared_buffers_GB * 512   # 每页 2MB
```

例如 shared_buffers=8GB → 4096 页。需在 Postgres 中启用 `huge_pages = try` 或 `on`。

### 若 reth/geth 未来支持 huge pages

再按实际 cache 大小计算，并预留约 15–20% 余量给系统和其他进程。
