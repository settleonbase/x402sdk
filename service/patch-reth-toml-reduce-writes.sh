#!/bin/bash
# 进一步增大 commit_threshold，减少落盘频率，让出磁盘带宽给读
# op-reth 仅支持 SafeNoSync，已是最激进模式；通过增大批次减少写次数

RETH_TOML="${1:-/home/peter/base/op-reth/reth.toml}"

[ ! -f "$RETH_TOML" ] && { echo "reth.toml 不存在: $RETH_TOML"; exit 1; }

cp "$RETH_TOML" "${RETH_TOML}.bak.reduce-writes.$(date +%s)"

# headers: 20000 -> 50000
sed -i '/\[stages.headers\]/,/^\[/ s/commit_threshold = 20000/commit_threshold = 50000/' "$RETH_TOML"

# sender_recovery: 5000000 -> 10000000
sed -i '/\[stages.sender_recovery\]/,/^\[/ s/commit_threshold = 5000000/commit_threshold = 10000000/' "$RETH_TOML"

# prune: 1000000 -> 3000000
sed -i '/\[stages.prune\]/,/^\[/ s/commit_threshold = 1000000/commit_threshold = 3000000/' "$RETH_TOML"

# account_hashing (原 100000)
sed -i '/\[stages.account_hashing\]/,/^\[/ s/commit_threshold = 100000/commit_threshold = 500000/' "$RETH_TOML"

# storage_hashing (原 100000)
sed -i '/\[stages.storage_hashing\]/,/^\[/ s/commit_threshold = 100000/commit_threshold = 500000/' "$RETH_TOML"

# index_account_history (原 100000)
sed -i '/\[stages.index_account_history\]/,/^\[/ s/commit_threshold = 100000/commit_threshold = 500000/' "$RETH_TOML"

# index_storage_history (原 100000)
sed -i '/\[stages.index_storage_history\]/,/^\[/ s/commit_threshold = 100000/commit_threshold = 500000/' "$RETH_TOML"

echo "reth.toml 写优化已应用"
grep -E "commit_threshold" "$RETH_TOML"
