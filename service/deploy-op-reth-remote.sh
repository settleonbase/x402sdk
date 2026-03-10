#!/bin/bash
# 远程部署脚本：移动解冻快照并启动 op-reth + op-node
# 用法: scp 到远程后执行 sudo ./deploy-op-reth-remote.sh

set -e
cd "$(dirname "$0")"

SNAPSHOT_SRC="/home/peter/snapshots"
BASE_DIR="/home/peter/base"
OP_RETH_DIR="${BASE_DIR}/op-reth"
COMPOSE_FILE="docker-compose-op-reth-home.yml"

echo "=== 1. 检查快照源 ==="
[ -d "$SNAPSHOT_SRC" ] || { echo "Error: 快照目录不存在: $SNAPSHOT_SRC"; exit 1; }

echo "=== 2. 创建 base 目录结构 ==="
mkdir -p "$OP_RETH_DIR" "$BASE_DIR/jwt" "$BASE_DIR/config" "$BASE_DIR/op-node"

echo "=== 3. 移动解冻快照到 op-reth 数据目录 ==="
# op-reth 数据目录: /home/peter/base/op-reth
# 支持结构: snapshots/db, snapshots/mainnet/download/, 或整目录
SNAPSHOT_DATADIR=""
if [ -d "$SNAPSHOT_SRC/db" ] || [ -f "$SNAPSHOT_SRC/chain" ]; then
  SNAPSHOT_DATADIR="$SNAPSHOT_SRC"
elif [ -d "$SNAPSHOT_SRC/mainnet/download/db" ]; then
  SNAPSHOT_DATADIR="$SNAPSHOT_SRC/mainnet/download"
fi

if [ -n "$SNAPSHOT_DATADIR" ]; then
  echo "检测到 reth datadir ($SNAPSHOT_DATADIR)，移入 op-reth..."
  rm -rf "$OP_RETH_DIR"/db "$OP_RETH_DIR"/static_files "$OP_RETH_DIR"/blobstore \
         "$OP_RETH_DIR"/invalid_block_hooks "$OP_RETH_DIR"/reth.toml 2>/dev/null || true
  mv "$SNAPSHOT_DATADIR"/db "$OP_RETH_DIR/"
  mv "$SNAPSHOT_DATADIR"/static_files "$OP_RETH_DIR/" 2>/dev/null || true
  mv "$SNAPSHOT_DATADIR"/blobstore "$OP_RETH_DIR/" 2>/dev/null || true
  mv "$SNAPSHOT_DATADIR"/invalid_block_hooks "$OP_RETH_DIR/" 2>/dev/null || true
  mv "$SNAPSHOT_DATADIR"/reth.toml "$OP_RETH_DIR/" 2>/dev/null || true
  mv "$SNAPSHOT_DATADIR"/known-peers.json "$OP_RETH_DIR/" 2>/dev/null || true
  rm -rf "$SNAPSHOT_SRC"
else
  mv "$SNAPSHOT_SRC" "$BASE_DIR/"
fi

echo "=== 4. 检查 jwt.hex ==="
[ -f "$BASE_DIR/jwt/jwt.hex" ] || { echo "请先生成: openssl rand -hex 32 > $BASE_DIR/jwt/jwt.hex"; exit 1; }

echo "=== 5. 启动 op-reth 和 op-node ==="
sudo docker compose -f "$COMPOSE_FILE" up -d

echo "=== 完成 ==="
sudo docker compose -f "$COMPOSE_FILE" ps
