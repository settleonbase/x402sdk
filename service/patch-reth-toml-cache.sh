#!/bin/bash
# 增加 reth.toml 缓存/缓冲，缓解磁盘读瓶颈
# 在服务器 /home/peter/base 目录执行

RETH_TOML="${1:-/home/peter/base/op-reth/reth.toml}"

[ ! -f "$RETH_TOML" ] && { echo "reth.toml 不存在: $RETH_TOML"; exit 1; }

cp "$RETH_TOML" "${RETH_TOML}.bak.$(date +%s)"

sed -i 's/downloader_max_buffered_responses = 100/downloader_max_buffered_responses = 200/' "$RETH_TOML"
sed -i 's/commit_threshold = 10000/commit_threshold = 20000/' "$RETH_TOML"
sed -i 's/downloader_request_limit = 1000/downloader_request_limit = 2000/' "$RETH_TOML"
sed -i 's/downloader_max_concurrent_requests = 100/downloader_max_concurrent_requests = 200/' "$RETH_TOML"
sed -i 's/downloader_min_concurrent_requests = 5/downloader_min_concurrent_requests = 20/' "$RETH_TOML"

# bodies 段（仅改 bodies，避免误改 headers 的 2000）
sed -i '/\[stages.bodies\]/,/^\[/ s/downloader_request_limit = 200/downloader_request_limit = 400/' "$RETH_TOML"
sed -i 's/downloader_max_buffered_blocks_size_bytes = 2147483648/downloader_max_buffered_blocks_size_bytes = 4294967296/' "$RETH_TOML"
sed -i 's/downloader_stream_batch_size = 1000/downloader_stream_batch_size = 2000/' "$RETH_TOML"

# sessions
sed -i 's/session_command_buffer = 32/session_command_buffer = 64/' "$RETH_TOML"
sed -i 's/session_event_buffer = 260/session_event_buffer = 512/' "$RETH_TOML"

# ETL 单文件更大，减少磁盘碎片
sed -i 's/file_size = 524288000/file_size = 1073741824/' "$RETH_TOML"

# merkle 阶段
sed -i 's/incremental_threshold = 7000/incremental_threshold = 20000/' "$RETH_TOML"
sed -i 's/rebuild_threshold = 100000/rebuild_threshold = 200000/' "$RETH_TOML"

# peers 并发拨号
sed -i 's/max_concurrent_outbound_dials = 15/max_concurrent_outbound_dials = 30/' "$RETH_TOML"

echo "reth.toml 已更新，备份已保存"
grep -E "downloader_|commit_threshold|session_|file_size|incremental|rebuild|max_concurrent" "$RETH_TOML" | head -25
