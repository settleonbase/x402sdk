#!/bin/bash
# 将 op-reth 的 etl-tmp 迁移到 /media/sda/baseTemp
# 前提：op-reth 已停止 (systemctl stop base-op-reth-native.service)
set -e

SRC="/home/peter/base/op-reth/etl-tmp"
DST="/media/sda/baseTemp"
RETH_TOML="/home/peter/base/op-reth/reth.toml"

echo "=== 1. 检查 op-reth 已停止 ==="
if systemctl is-active base-op-reth-native.service 2>/dev/null | grep -q active; then
  echo "ERROR: op-reth 仍在运行，请先执行: sudo systemctl stop base-op-reth-native.service"
  exit 1
fi
echo "op-reth: inactive"

echo ""
echo "=== 2. Copy etl-tmp 到 /media/sda/baseTemp ==="
mkdir -p "$DST"
if [ -d "$SRC" ]; then
  rsync -av --progress "$SRC"/ "$DST"/
else
  echo "源目录不存在: $SRC"
  exit 1
fi

echo ""
echo "=== 3. 校验 copy 结果 ==="
SRC_SIZE=$(du -sb "$SRC" 2>/dev/null | cut -f1)
DST_SIZE=$(du -sb "$DST" 2>/dev/null | cut -f1)
if [ "$SRC_SIZE" = "$DST_SIZE" ]; then
  echo "校验通过: $SRC_SIZE bytes"
else
  echo "WARN: 大小不一致 SRC=$SRC_SIZE DST=$DST_SIZE"
  read -p "是否继续删除源目录? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
fi

echo ""
echo "=== 4. 删除原 etl-tmp ==="
rm -rf "$SRC"
echo "已删除 $SRC"

echo ""
echo "=== 5. 更新 reth.toml 指定 ETL 目录 ==="
if grep -q 'dir = "/media/sda/baseTemp"' "$RETH_TOML" 2>/dev/null; then
  echo "reth.toml 已配置 ETL dir"
else
  if grep -q '^dir = ' "$RETH_TOML" 2>/dev/null; then
    sed -i "s|^dir = .*|dir = \"$DST\"|" "$RETH_TOML"
  else
    sed -i "/^\[stages\.etl\]/a dir = \"$DST\"" "$RETH_TOML"
  fi
  echo "reth.toml 已更新"
fi

echo ""
echo "=== 完成 ==="
echo "可启动 op-reth: sudo systemctl start base-op-reth-native.service"
