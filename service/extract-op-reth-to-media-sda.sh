#!/bin/bash
# 从 Docker 镜像提取 op-reth 二进制到 /media/sda/bin
# 用法: 在远程服务器执行 bash extract-op-reth-to-media-sda.sh
set -e

BIN_NAME="op-reth-v1.11.3-rc.3"
TARGET_DIR="/media/sda/bin"
# 使用 v1.11.3 稳定版（若 v1.11.3-rc.3 不存在）
IMAGE="${OP_RETH_IMAGE:-ghcr.io/paradigmxyz/op-reth:v1.11.3}"

echo "=== 1. 创建目录 ==="
sudo mkdir -p "$TARGET_DIR"
sudo chown peter:peter "$TARGET_DIR"

echo "=== 2. 从 Docker 镜像提取 op-reth ==="
# op-reth 镜像的 entrypoint 通常是 op-reth
CID=$(docker create "$IMAGE" 2>/dev/null)
docker cp "$CID:/usr/local/bin/op-reth" /tmp/op-reth 2>/dev/null || \
docker cp "$CID:/op-reth" /tmp/op-reth 2>/dev/null || \
docker cp "$CID:/usr/bin/op-reth" /tmp/op-reth 2>/dev/null || {
  echo "尝试查找镜像内 op-reth 路径..."
  docker export "$CID" | tar -t | grep -E "op-reth$|bin/op-reth" | head -5
  docker rm "$CID" 2>/dev/null
  exit 1
}
docker rm "$CID" 2>/dev/null

echo "=== 3. 复制到 /media/sda/bin ==="
chmod +x /tmp/op-reth
mv /tmp/op-reth "$TARGET_DIR/$BIN_NAME"

echo "=== 4. 验证 ==="
ls -la "$TARGET_DIR/$BIN_NAME"
"$TARGET_DIR/$BIN_NAME" --version 2>/dev/null || true

echo "=== 完成。请更新 systemd 并重启服务 ==="
