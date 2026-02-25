#!/bin/bash
# 解压快照到 /home/peter/base/op-reth，部署并启动 Base RPC
set -e

BASE_DIR=/home/peter/base
SNAPSHOT=/media/sda/base-mainnet-pruned-reth-1771845718.tar.zst

echo "=== $(date) 开始部署 Base RPC ==="

# 1. 创建目录结构
mkdir -p "$BASE_DIR"/{op-reth,op-node,jwt,config}
cp -a /media/sda/base/jwt/* "$BASE_DIR/jwt/"
cp -a /media/sda/base/config/* "$BASE_DIR/config/"
echo "jwt 和 config 已准备"

# 2. 停止已有容器
cd "$BASE_DIR"
[ -f docker-compose-op-reth-home.yml ] && sudo docker compose -f docker-compose-op-reth-home.yml down 2>/dev/null || true

# 3. 解压快照到 op-reth (约 1-2 小时)
sudo rm -rf "$BASE_DIR/op-reth"/*
echo "解压快照到 $BASE_DIR/op-reth ..."
tar -I zstd -xvf "$SNAPSHOT" -C "$BASE_DIR/op-reth"
echo "快照解压完成"

# 4. 启动 Base RPC
sudo docker compose -f docker-compose-op-reth-home.yml up -d
echo "=== $(date) 部署完成 ==="
