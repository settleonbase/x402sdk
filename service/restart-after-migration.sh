#!/bin/bash
# 迁移完成后执行：启动 op-reth 和 op-node
# 用法: 在远程服务器上执行 ./restart-after-migration.sh
# 或: ssh peter@38.102.126.30 'cd /home/peter/base && sudo ./restart-after-migration.sh'

set -e

echo "=== 1. 确认迁移已完成 ==="
if [ -d /home/peter/base/op-reth/static_files ] && [ "$(ls -A /home/peter/base/op-reth/static_files 2>/dev/null)" ]; then
  echo "警告: static_files 尚未迁移完成，请等待 rsync 完成"
  echo "查看进度: tail -f /tmp/migrate-op-reth.log"
  exit 1
fi
echo "   static_files 已迁移"

if [ -d /home/peter/base/op-reth/etl-tmp ] && [ "$(ls -A /home/peter/base/op-reth/etl-tmp 2>/dev/null)" ]; then
  echo "   etl-tmp 可能仍在迁移，继续..."
fi

echo ""
echo "=== 2. 启动 op-reth (systemd) ==="
sudo systemctl start base-op-reth-native.service
sleep 3
systemctl status base-op-reth-native.service | head -5

echo ""
echo "=== 3. 启动 op-node (docker) ==="
cd /home/peter/base
sudo docker compose -f docker-compose-op-reth-home.yml up -d op-node

echo ""
echo "=== 4. 验证 ==="
df -h / /media/sda
echo ""
echo "op-reth 日志: sudo journalctl -u base-op-reth-native.service -f"
echo "op-node 日志: sudo docker logs -f base-op-node"
