#!/bin/bash
# 判断迁移是否真正完成（目录已空 且 无迁移进程）
# 退出码 0=完成 1=未完成

# 1. 检查是否有 rsync/mv 迁移进程（避免目录刚空但进程未退出）
if ps aux 2>/dev/null | grep -v grep | grep -E "rsync|mv" | grep -qE "op-reth|op-reth-static|op-reth-etl-tmp"; then
  exit 1
fi

# 2. static_files 源目录必须已空或不存在
if [ -d /home/peter/base/op-reth/static_files ] && [ -n "$(ls -A /home/peter/base/op-reth/static_files 2>/dev/null)" ]; then
  exit 1
fi

# 3. etl-tmp 源目录必须已空或不存在
if [ -d /home/peter/base/op-reth/etl-tmp ] && [ -n "$(ls -A /home/peter/base/op-reth/etl-tmp 2>/dev/null)" ]; then
  exit 1
fi

exit 0
