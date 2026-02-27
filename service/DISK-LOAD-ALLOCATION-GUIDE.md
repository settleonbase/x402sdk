# 硬盘负荷分配与追赶加速指南

基于公开资料整理的磁盘 I/O 调优策略，用于加速 Base op-reth 节点追赶速度。

---

## 一、问题背景

- **瓶颈**：NVMe 上 mdbx.dat (2.1 TB) 的集中读与写竞争
- **目标**：将磁盘带宽更多分配给读，减少写对读的干扰

---

## 二、Linux 内核层调优

### 2.1 I/O 调度器 (I/O Scheduler)

NVMe 默认可能使用 `none`、`mq-deadline` 或 `kyber`。研究显示：

| 调度器 | 特点 | 适用场景 |
|--------|------|----------|
| **none** | 无调度，延迟最低，NVMe 直通 | 单进程独占、追求最低延迟 |
| **kyber** | 为快速 SSD 设计，读写干扰时读延迟可降 26% | 读写混合、多进程竞争 |
| **bfq** | 公平队列，CPU 开销大 | 多用户桌面 |
| **mq-deadline** | 软延迟截止，多进程时锁竞争明显 | 一般场景 |

**建议**：若 op-reth 为主要 I/O 进程，可尝试 `none` 降低调度开销；若存在其他进程竞争，可试 `kyber`。

```bash
# 查看当前调度器
cat /sys/block/nvme0n1/queue/scheduler

# 设置为 none（需 root）
echo none | sudo tee /sys/block/nvme0n1/queue/scheduler

# 持久化：/etc/rc.local 或 systemd tmpfiles
```

### 2.2 读预取 (read_ahead_kb)

当前值通常为 4–128 KB。对顺序读较多的数据库可适当增大：

```bash
# 查看
cat /sys/block/nvme0n1/queue/read_ahead_kb

# 增大到 4MB（对顺序读有利）
echo 4096 | sudo tee /sys/block/nvme0n1/queue/read_ahead_kb
```

**注意**：mdbx 以随机读为主，收益可能有限；若存在顺序块读取，可尝试 4–8 MB。

### 2.3 脏页写回 (vm.dirty_*)

控制脏页在内存中停留多久再 flush：

| 参数 | 默认 | 调大效果 | 调小效果 |
|------|------|----------|----------|
| vm.dirty_ratio | 20% | 更多写批处理，减少 flush 频率 | 更早 flush，减少写突发 |
| vm.dirty_background_ratio | 10% | 后台 flush 更晚触发 | 更早后台 flush |

**建议**：为减轻写对读的干扰，可适度提高，让写更多在内存中批处理：

```bash
# 临时
sudo sysctl -w vm.dirty_ratio=40
sudo sysctl -w vm.dirty_background_ratio=20

# 持久化：/etc/sysctl.d/99-disk-tune.conf
vm.dirty_ratio = 40
vm.dirty_background_ratio = 20
```

**风险**：宕机时可能丢失更多未落盘数据；SafeNoSync 已承担部分风险。

### 2.4 挂载选项 (noatime)

减少元数据写入：

```bash
# 在 /etc/fstab 中为数据分区添加 noatime
/dev/mapper/vg0-root  /  ext4  defaults,noatime  0  1
```

---

## 三、进程 I/O 优先级 (ionice)

提高 op-reth 的 I/O 优先级，让读优先于后台 flush：

```bash
# 查看
ionice -p $(docker inspect -f "{{.State.Pid}}" base-op-reth)

# 设置 best-effort 最高优先级 (0-7, 0 最高)
ionice -c 2 -n 0 -p $(docker inspect -f "{{.State.Pid}}" base-op-reth)
```

**Docker 集成**：在 compose 中通过 `ulimits` 或 `oom_score_adj` 间接影响；或使用 `systemd` 的 `IOSchedulingClass` 和 `IOSchedulingPriority` 管理容器。

---

## 四、Reth 存储分层 (--datadir.static-files)

若存在 **第二块盘**（如 HDD /media/sda），可将静态文件迁出 NVMe，减少对 mdbx.dat 的竞争：

```yaml
# op-reth 添加
- "--datadir.static-files=/data-static"
```

并挂载：

```yaml
volumes:
  - /home/peter/base/op-reth:/data
  - /media/sda/base/op-reth-static:/data-static  # 静态文件放 HDD
```

**注意**：需在初始化或迁移时配置，已有数据可能需重新导入或迁移。

---

## 五、实施优先级建议

| 优先级 | 措施 | 实施难度 | 预期效果 |
|--------|------|----------|----------|
| 1 | 检查并设置 I/O 调度器为 `none` | 低 | 降低调度开销 |
| 2 | 提高 read_ahead_kb 至 4096 | 低 | 可能改善顺序读 |
| 3 | 适度提高 vm.dirty_ratio | 低 | 减少写 flush 频率 |
| 4 | 挂载 noatime | 中 | 减少元数据写入 |
| 5 | ionice 提高 op-reth 优先级 | 中 | 读优先于后台 flush |
| 6 | 存储分层（静态文件迁 HDD） | 高 | 减轻 NVMe 读写竞争 |

---

## 六、监控与验证

```bash
# 调度器
cat /sys/block/nvme0n1/queue/scheduler

# 实时 I/O
iostat -x nvme0n1 1

# 脏页
grep -E "Dirty|Writeback" /proc/meminfo
```

---

## 七、参考

- [Reth System Requirements](https://reth.rs/run/system-requirements/)
- [Linux vm.dirty_* 调优](https://access.redhat.com/articles/45002)
- [BFQ/Kyber/MQ-Deadline 对比 (2024)](https://atlarge-research.com/talks/2024-icpe-scheduler-benchmark.html)
- [read_ahead_kb 调优](https://docs.oracle.com/cd/E29584_01/webhelp/PerfTuning/src/tperf_tuning_the_read_ahead_kb_kernel_parameter.html)
