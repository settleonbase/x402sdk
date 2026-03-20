# 硬盘读写负荷评估

## 磁盘布局

| 设备 | 类型 | 容量 | 挂载 | 主要用途 |
|------|------|------|------|----------|
| **nvme0n1** | NVMe | 2.9T | / (vg0-root) | op-reth db (2.4T)、系统、/home |
| **sda** | HDD | 18.2T | /media/sda | geth、lighthouse、op-reth-static、快照、临时文件 |

## I/O 采样结果 (2026-03-20 更新，geth/lighthouse 运行中)

### NVMe (nvme0n1) — op-reth db

| 指标 | 值 | 评估 |
|------|-----|------|
| 读 IOPS | ~4k–11k/s | 高 |
| 读吞吐 | ~18–44 MB/s | 中高 |
| 写 IOPS | ~3k–13k/s | 高，波动 |
| 写吞吐 | ~26–58 MB/s | 高 |
| **%util** | **38–65%** | 中等负荷 |
| r_await | ~0.09 ms | 极低 |
| w_await | ~0.15 ms | 极低 |

### HDD (sda) — geth、lighthouse、op-reth-static

| 指标 | 值 | 评估 |
|------|-----|------|
| 读 IOPS | 0–185/s | 波动大（同步时升高） |
| 读吞吐 | 0–13 MB/s | 视同步阶段而定 |
| 写 IOPS | 18–69/s | 持续写入 |
| 写吞吐 | ~7–27 MB/s | 持续 |
| **%util** | **24–61%** | 中高，峰值可达 60%+ |
| r_await | ~16 ms | HDD 典型 |
| w_await | ~11–38 ms | 有排队 |

## 关联文件夹使用总量

| 路径 | 大小 | 磁盘 | 用途 |
|------|------|------|------|
| /media/sda/eth/geth/geth | **1.5T** | HDD | geth chaindata (L1 主网) |
| /media/sda/eth/lighthouse | **225G** | HDD | Lighthouse beacon 链数据 |
| /home/peter/base/op-reth/db | **2.4T** | NVMe | op-reth Base L2 数据库 |
| /media/sda/base/op-reth-static | **128G** | HDD | op-reth 静态文件 |
| /media/sda/baseTemp | **584G** | HDD | 临时/解压工作区 |
| /media/sda/base-mainnet-pruned-reth-*.tar.zst | **1.2T** | HDD | Base 快照压缩包（可删除） |
| /media/sda/ethereum-pos-mainnet | **266G** | HDD | 历史/备份数据 |
| /media/sda/baseBackup | **29G** | HDD | 备份 |

### 汇总

| 磁盘 | 已用 | 可用 | 使用率 | 主要消费者 |
|------|------|------|--------|------------|
| / (NVMe) | 2.4T | 327G | 89% | op-reth db |
| /media/sda (HDD) | 3.8T | 14T | 23% | geth、lighthouse、快照、baseTemp |

## 进程 I/O 贡献

| 进程 | 主要磁盘 | 说明 |
|------|----------|------|
| geth | HDD (sda) | 1.5T chaindata，同步时读多写多 |
| lighthouse | HDD (sda) | 225G beacon 数据，读写 |
| op-reth | NVMe + HDD | db 在 NVMe，static 在 HDD |

## 结论与建议

### 当前状态

1. **NVMe**：op-reth db 在 NVMe，利用率 38–65%，延迟极低，表现正常。
2. **HDD**：geth + lighthouse 在 HDD，利用率 24–61%，同步时更高。r_await/w_await 升高时会拖慢 Engine API，导致 lighthouse 超时。
3. **空间**：NVMe 剩余 327G，需关注；HDD 剩余 14T，充足。

### 建议

1. **短期**：维持 lighthouse `--execution-timeout-multiplier 12`，应对 geth 在 HDD 上的间歇性延迟。
2. **中期**：若 snapshot 已正确解压并导入，可删除 `/media/sda/base-mainnet-pruned-reth-*.tar.zst`（约 1.2T），释放 HDD 空间。
3. **长期**：将 geth/lighthouse 迁至 SSD，可显著降低 Engine API 超时和同步延迟；或增加 NVMe 容量后迁移 op-reth db 外的数据。
