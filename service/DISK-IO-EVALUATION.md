# 硬盘读写负荷评估

## 磁盘布局

| 设备 | 类型 | 容量 | 挂载 | 用途 |
|------|------|------|------|------|
| **nvme0n1** | NVMe | 2.9T | / (vg0-root) | op-reth db (2.4T)、系统 |
| **sda** | HDD | 18.2T | /media/sda | op-reth static/etl-tmp（geth/lighthouse 已停） |

## I/O 采样结果 (5s 平均，2026-03-13 更新，geth/lighthouse 已停)

### NVMe (nvme0n1)

| 指标 | 值 | 评估 |
|------|-----|------|
| 读 IOPS | ~2900-7700/s | 高 |
| 读吞吐 | ~11-31 MB/s | 中 |
| 写 IOPS | ~3700-57000/s | 波动大（含 checkpoint 突发） |
| 写吞吐 | ~23-354 MB/s | 波动大 |
| **%util** | **42-83%** | 健康（突发时升高） |
| r_await | ~0.09-0.30 ms | 极低 |
| w_await | ~0.12 ms | 极低 |

### HDD (sda)

| 指标 | 值 | 评估 |
|------|-----|------|
| 读 IOPS | 0/s | 空闲 |
| 写 IOPS | 0/s | 空闲 |
| **%util** | **0%** | ✅ 空闲 |
| r_await | - | - |
| w_await | - | - |

**geth/lighthouse 停止后，HDD 已无负载。**

## 进程 I/O 贡献

| 进程 | 读 (kB/s) | 写 (kB/s) | 主要磁盘 |
|------|-----------|-----------|----------|
| op-reth | ~31900 | ~41000 | NVMe (db) |

op-reth 是唯一 I/O 消费者，全部落在 NVMe。

## 数据分布

| 路径 | 大小 | 磁盘 |
|------|------|------|
| /home/peter/base/op-reth (db) | 2.4T | NVMe |
| /media/sda/base/op-reth-static | 178G | HDD |
| /media/sda/base/op-reth-etl-tmp | 配置指向 | HDD |
| /media/sda/eth/geth | - | HDD（已停） |
| /media/sda/eth/lighthouse | 245G | HDD（已停） |

## 结论与建议

### 当前状态（geth/lighthouse 已停）

1. **NVMe**：op-reth db 在 NVMe，利用率 42-83%，延迟极低，表现良好。采样期间有 checkpoint 写突发（~354 MB/s）。
2. **HDD**：**0% 利用率，完全空闲**。geth/lighthouse 停止后无负载。
3. **op-reth**：读 ~32 MB/s，写 ~41 MB/s，为主要 I/O 消费者，全部落在 NVMe。

### 建议

1. **当前**：HDD 已空闲，无瓶颈。op-reth 独占 NVMe，I/O 表现正常。
2. **若重启 geth/lighthouse**：HDD 将恢复负载，可能再次饱和（71-94% util）。
3. **ionice**：可为 op-reth 设置 `ionice -c 1 -n 0`，保证其 NVMe 优先。
