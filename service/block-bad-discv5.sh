#!/bin/bash
# 从 op-node 最后 500 条日志中提取 Bad discv5 IP 并屏蔽
# 由 systemd timer 每 15 秒执行

CONTAINER="${BLOCK_DISCV5_CONTAINER:-base-op-node}"
TAIL="${BLOCK_DISCV5_TAIL:-1000}"
RULES_FILE="${BLOCK_DISCV5_RULES:-/etc/iptables.rules}"
LOG_FILE="${BLOCK_DISCV5_LOG:-/home/peter/base/block-bad-discv5.log}"

log() { echo "$(date -Iseconds) $*" >> "$LOG_FILE"; }

IPS=$(sudo docker logs "$CONTAINER" --tail "$TAIL" 2>&1 \
  | grep "p2p=discv5 id=0000000000000000000000000000000000000000000000000000000000000000" \
  | grep -oE "addr=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+" \
  | sed 's/addr=//' \
  | cut -d: -f1 \
  | sort -u)

[ -z "$IPS" ] && exit 0

BLOCKED=$(sudo iptables -L INPUT -n 2>/dev/null | grep DROP | awk '{print $4}' | sort -u)
REMAIN=$(comm -23 <(echo "$IPS") <(echo "$BLOCKED"))

[ -z "$REMAIN" ] && exit 0

count=0
for ip in $REMAIN; do
  sudo iptables -I INPUT -s "$ip" -j DROP 2>/dev/null && count=$((count+1))
done

if [ $count -gt 0 ]; then
  sudo sh -c "iptables-save > $RULES_FILE" 2>/dev/null || true
  log "新增屏蔽 $count 个 IP"
fi
