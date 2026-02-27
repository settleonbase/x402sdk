#!/bin/bash
# 检查 op-node 是否已进入 Engine Queue，并估算剩余时间
# 在服务器上执行，需能访问 op-node RPC (localhost:8549) 和 reth RPC (localhost:8547)
#
# 用法: ./check-op-node-engine-queue.sh
# 或: OP_NODE_RPC=http://38.102.126.30:8549 RETH_RPC=http://38.102.126.30:8547 ./check-op-node-engine-queue.sh

set -e

OP_NODE_RPC="${OP_NODE_RPC:-http://localhost:8549}"
RETH_RPC="${RETH_RPC:-http://localhost:8547}"

echo "=== op-node Engine Queue 状态检查 ==="
echo "op-node RPC: $OP_NODE_RPC"
echo "reth RPC: $RETH_RPC"
echo ""

# 1. 获取 op-node sync 状态
echo "1. 查询 optimism_syncStatus..."
SYNC_JSON=$(curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"optimism_syncStatus","params":[],"id":1}' \
  "$OP_NODE_RPC" 2>/dev/null || echo '{"error":"failed"}')

if echo "$SYNC_JSON" | grep -q '"error"'; then
  echo "   [错误] 无法连接 op-node，请确认 op-node 在运行且端口 8549 可访问"
  echo "   响应: $SYNC_JSON"
  exit 1
fi
echo "   [OK] 已连接"

# 2. 获取 reth 当前区块高度
echo ""
echo "2. 查询 reth 当前 L2 区块..."
L2_BLOCK_HEX=$(curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  "$RETH_RPC" 2>/dev/null | grep -o '"result":"[^"]*"' | cut -d'"' -f4)

if [ -z "$L2_BLOCK_HEX" ]; then
  echo "   [警告] 无法获取 reth 区块高度，请确认 reth RPC 在 8547 可访问"
  L2_BLOCK=0
else
  L2_BLOCK=$((L2_BLOCK_HEX))
  echo "   reth L2 当前高度: $L2_BLOCK"
fi

# 3. 用 jq 解析（若有）
hex2dec() { printf '%d' "$1"; }
if command -v jq &>/dev/null; then
  echo ""
  echo "3. 解析 sync 状态 (jq)..."
  # 支持 hex 或 decimal
  CURRENT_L1_RAW=$(echo "$SYNC_JSON" | jq -r '.result.current_l1.number // empty')
  HEAD_L1_RAW=$(echo "$SYNC_JSON" | jq -r '.result.head_l1.number // empty')
  UNSAFE_L2_RAW=$(echo "$SYNC_JSON" | jq -r '.result.unsafe_l2.number // empty')
  SAFE_L2_RAW=$(echo "$SYNC_JSON" | jq -r '.result.safe_l2.number // empty')
  L1_ORIGIN_RAW=$(echo "$SYNC_JSON" | jq -r '.result.unsafe_l2.l1origin.number // empty')

  CURRENT_L1=$([ -n "$CURRENT_L1_RAW" ] && ([[ "$CURRENT_L1_RAW" == 0x* ]] && hex2dec "$CURRENT_L1_RAW" || echo "$CURRENT_L1_RAW") || echo "")
  HEAD_L1=$([ -n "$HEAD_L1_RAW" ] && ([[ "$HEAD_L1_RAW" == 0x* ]] && hex2dec "$HEAD_L1_RAW" || echo "$HEAD_L1_RAW") || echo "")
  UNSAFE_L2=$([ -n "$UNSAFE_L2_RAW" ] && ([[ "$UNSAFE_L2_RAW" == 0x* ]] && hex2dec "$UNSAFE_L2_RAW" || echo "$UNSAFE_L2_RAW") || echo "")
  SAFE_L2=$([ -n "$SAFE_L2_RAW" ] && ([[ "$SAFE_L2_RAW" == 0x* ]] && hex2dec "$SAFE_L2_RAW" || echo "$SAFE_L2_RAW") || echo "")
  L1_ORIGIN=$([ -n "$L1_ORIGIN_RAW" ] && ([[ "$L1_ORIGIN_RAW" == 0x* ]] && hex2dec "$L1_ORIGIN_RAW" || echo "$L1_ORIGIN_RAW") || echo "")

  echo "   current_l1 (回溯中): $CURRENT_L1"
  echo "   head_l1 (L1 链头):  $HEAD_L1"
  echo "   unsafe_l2 (reth):   $UNSAFE_L2"
  echo "   safe_l2:            $SAFE_L2"
  echo "   unsafe_l2.l1origin: $L1_ORIGIN"

  echo ""
  echo "4. 状态判断:"
  if [ -n "$CURRENT_L1" ] && [ -n "$L1_ORIGIN" ]; then
    # channel-timeout 约 50，base 需比 l1origin 早约 50 块
    L1_REMAINTING=$((CURRENT_L1 - L1_ORIGIN + 50))
    if [ "$L1_REMAINTING" -lt 0 ]; then L1_REMAINTING=0; fi
    echo "   目标 L1 区块 (base): ~$((L1_ORIGIN - 50))"
    echo "   当前回溯到 L1:       $CURRENT_L1"
    echo "   预计剩余 L1 区块:    ~$L1_REMAINTING"
    if [ "$L1_REMAINTING" -lt 100 ]; then
      EST_MIN=$((L1_REMAINTING / 20))
      [ "$EST_MIN" -lt 1 ] && EST_MIN=1
      echo "   预计剩余时间:        约 ${EST_MIN}-$((L1_REMAINTING / 10 + 1)) 分钟"
    else
      echo "   预计剩余时间:        约 $((L1_REMAINTING / 60)) 分钟"
    fi
  fi

  if [ -n "$SAFE_L2" ] && [ -n "$UNSAFE_L2" ]; then
    if [ "$SAFE_L2" = "$UNSAFE_L2" ]; then
      echo ""
      echo "   safe_l2 == unsafe_l2 (区块 $SAFE_L2)"
      echo "   → 若区块号持续增长，则已进入 Engine Queue"
    else
      echo ""
      echo "   safe_l2 ($SAFE_L2) < unsafe_l2 ($UNSAFE_L2)"
      echo "   → 已进入 Engine Queue，正在 consolidation"
    fi
  fi
fi

# 4. 输出完整 sync 状态
echo ""
echo "5. 完整 optimism_syncStatus 响应:"
if command -v jq &>/dev/null; then
  echo "$SYNC_JSON" | jq '.' 2>/dev/null || echo "$SYNC_JSON"
else
  echo "$SYNC_JSON"
fi

echo ""
echo "6. 建议:"
echo "   - 若 current_l1 在递减，说明 Walking back 正常，静默属正常"
echo "   - 进入 Engine Queue 后，reth 将收到 engine_forkchoiceUpdated/newPayload"
echo "   - 若超过 30 分钟 current_l1 无变化，检查 L1 RPC/Beacon"
