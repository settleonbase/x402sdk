#!/bin/bash
# copy 完成后执行：校验、删除原 etl-tmp、启动 op-reth
# 在远程服务器上运行
set -e

SRC="/home/peter/base/op-reth/etl-tmp"
DST="/media/sda/baseTemp"

echo "=== 1. 确认 copy 已完成 ==="
if pgrep -f "cp -a.*etl-tmp" >/dev/null; then
  echo "copy 仍在进行中，请等待完成后再运行此脚本"
  exit 1
fi
echo "copy 已结束"

echo ""
echo "=== 2. 校验 ==="
SRC_SIZE=$(du -sb "$SRC" 2>/dev/null | cut -f1 || echo 0)
DST_SIZE=$(du -sb "$DST" 2>/dev/null | cut -f1 || echo 0)
echo "源: $SRC_SIZE bytes"
echo "目标: $DST_SIZE bytes"
if [ "$SRC_SIZE" != "0" ] && [ "$SRC_SIZE" = "$DST_SIZE" ]; then
  echo "校验通过"
else
  echo "WARN: 大小可能不一致，请确认"
  read -p "继续删除源目录? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
fi

echo ""
echo "=== 3. 删除原 etl-tmp ==="
rm -rf "$SRC"
echo "已删除 $SRC (约 584G 已释放)"

echo ""
echo "=== 4. 启动 op-reth ==="
sudo systemctl start base-op-reth-native.service
sleep 2
systemctl is-active base-op-reth-native.service && echo "op-reth 已启动"
