#!/bin/bash
# 解冻完成后：组装 base 工作目录、配置 reth、启动 reth 和 op-node
# 用法：在远程服务器执行 bash assemble-base-from-snapshot.sh
set -e

SRC=/home/peter/snapshots/mainnet/download
OP_RETH=/home/peter/base/op-reth
OP_RETH_STATIC=/media/sda/base/op-reth-static
BASE=/home/peter/base

echo "=== 1. 等待解冻结束（检测 tar -I zstd 进程）==="
while ps aux | grep -q "[t]ar -I zstd"; do
  echo "$(date +%H:%M:%S) 解压进行中... $(du -sh /home/peter/snapshots 2>/dev/null || echo "0")"
  sleep 120
done
echo "$(date +%H:%M:%S) 解压已结束"

echo "=== 2. 验证解压目录 ==="
[ -d "$SRC" ] || { echo "错误: $SRC 不存在"; exit 1; }
ls -la "$SRC"

echo "=== 3. 创建目录结构 ==="
sudo mkdir -p "$BASE"/op-reth "$BASE"/op-node "$BASE"/jwt "$BASE"/config "$OP_RETH_STATIC"
sudo chown -R peter:peter "$BASE"
sudo chown -R peter:peter "$OP_RETH_STATIC"

echo "=== 4. mv 主数据到 op-reth ==="
sudo rm -rf "$OP_RETH"/*
sudo mv "$SRC"/db "$SRC"/blobstore "$SRC"/reth.toml "$OP_RETH/"
[ -f "$SRC"/known-peers.json ] && sudo mv "$SRC"/known-peers.json "$OP_RETH/" || true
[ -d "$SRC"/etl-tmp ] && sudo mv "$SRC"/etl-tmp "$OP_RETH/" 2>/dev/null || true
[ -d "$SRC"/invalid_block_hooks ] && sudo mv "$SRC"/invalid_block_hooks "$OP_RETH/" 2>/dev/null || true
sudo chown -R peter:peter "$OP_RETH"

echo "=== 5. mv static_files 到 /media/sda/base/op-reth-static ==="
sudo rm -rf "$OP_RETH_STATIC"/*
sudo mv "$SRC"/static_files/* "$OP_RETH_STATIC/"
sudo chown -R peter:peter "$OP_RETH_STATIC"

echo "=== 6. jwt 和 config ==="
[ -d /media/sda/base/jwt ] && sudo cp -a /media/sda/base/jwt/* "$BASE/jwt/" 2>/dev/null || true
[ -d /media/sda/base/config ] && sudo cp -a /media/sda/base/config/* "$BASE/config/" 2>/dev/null || true
[ ! -f "$BASE/jwt/jwt.hex" ] && openssl rand -hex 32 | sudo tee "$BASE/jwt/jwt.hex" > /dev/null && sudo chown peter:peter "$BASE/jwt/jwt.hex" || true
sudo chown -R peter:peter "$BASE/jwt" "$BASE/config"

echo "=== 7. op-node 数据 ==="
[ -d /media/sda/base/op-node ] && sudo cp -a /media/sda/base/op-node/* "$BASE/op-node/" 2>/dev/null || true
sudo chown -R peter:peter "$BASE/op-node"

echo "=== 8. 配置 reth.toml prune ==="
RETH_TOML="$OP_RETH/reth.toml"
if [ -f "$RETH_TOML" ]; then
  # 确保 [prune] 段存在并设置 Distance(2678400)
  if ! grep -q "^\[prune\]" "$RETH_TOML"; then
    echo "" >> "$RETH_TOML"
    echo "[prune]" >> "$RETH_TOML"
  fi
  for key in blocks receipts sender_recovery tx_lookup; do
    if grep -q "^${key} " "$RETH_TOML"; then
      sudo sed -i "s/^${key} = .*/${key} = 2678400/" "$RETH_TOML"
    else
      echo "${key} = 2678400" | sudo tee -a "$RETH_TOML" > /dev/null
    fi
  done
  # account_history, storage_history, bodies_history - reth 可能用 stages 段
  for section in index_account_history index_storage_history bodies; do
    if grep -q "\[stages.${section}\]" "$RETH_TOML"; then
      sudo sed -i "/\[stages.${section}\]/,/^\[/ s/commit_threshold = [0-9]*/commit_threshold = 2678400/" "$RETH_TOML" 2>/dev/null || true
    fi
  done
  sudo chown peter:peter "$RETH_TOML"
  echo "reth.toml 已更新"
fi

echo "=== 9. 清理解冻目录 ==="
sudo rm -rf /home/peter/snapshots

echo "=== 10. 验证 ==="
ls -la "$OP_RETH"
echo "static_files: $(ls "$OP_RETH_STATIC" | wc -l)"
ls -la "$BASE"

echo "=== 11. 启动 reth 和 op-node ==="
sudo systemctl start base-op-reth-native.service
sudo docker start base-op-node

echo "=== 完成 ==="
systemctl is-active base-op-reth-native.service
sudo docker ps --format "{{.Names}} {{.Status}}" | grep base-op-node
