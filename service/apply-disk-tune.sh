#!/bin/bash
# 磁盘 I/O 调优：调度器、read_ahead、vm.dirty
# 需 root 执行；由 systemd 在启动时调用

set -e

# 1. I/O 调度器与 read_ahead（NVMe/SSD）
for dev in /sys/block/nvme*; do
  [ -d "$dev" ] || continue
  sched="$dev/queue/scheduler"
  ra="$dev/queue/read_ahead_kb"
  name=$(basename "$dev")
  if [ -f "$sched" ]; then
    if grep -q none "$sched"; then
      echo none > "$sched" 2>/dev/null && echo "  $name: scheduler=none" || true
    fi
  fi
  if [ -f "$ra" ]; then
    echo 4096 > "$ra" 2>/dev/null && echo "  $name: read_ahead_kb=4096" || true
  fi
done

# 2. vm.dirty 由 /etc/sysctl.d/99-disk-tune.conf 在启动时加载
