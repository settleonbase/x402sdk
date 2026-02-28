#!/bin/bash
# 从 op-node 日志中提取 Bad discv5（id=全零）的 IP 并加入 iptables DROP
# 规则含义：-s IP -j DROP = 丢弃该 IP 发出的所有报文，即全面屏蔽（本机任意端口 + 任意容器任意端口），不区分协议与端口
# 关键：到容器的流量必须先经 DOCKER-USER 再经 Docker 的 ACCEPT，故必须把 DROP 写在 DOCKER-USER 里
# （写在 FORWARD 会被 Docker 重建规则时冲掉或顺序落后，导致拦不住）
# 由 systemd timer 每 30 秒执行；规则需持久化（iptables-persistent 或开机脚本加载）
#
# 为何同一 IP（如 103.216.223.171）每轮都出现？
# 列表来源是「容器最近 TAIL 行日志」：只要某 IP 曾出现在这些行里，本轮就会再被加入列表并重写规则。
# 该行未被新日志顶出窗口前，该 IP 会一直出现在列表中；并非该 IP 仍在成功连入（raw PREROUTING 已丢弃其包）。
# op-node 内部可能仍保留该 peer 一段时间（如 10 分钟）才超时移除，但网络层已封禁。
#
# 防重叠运行：一轮要处理 200+ IP（约 4–5 分钟），若 timer 间隔过短会多实例并发，
# 导致 A 删某 IP 规则后、B 尚未插入前出现空窗，该 IP 仍能连入。故用 flock 保证同时只跑一轮。

CONTAINER="${BLOCK_DISCV5_CONTAINER:-base-op-node}"
TAIL="${BLOCK_DISCV5_TAIL:-2000}"
RULES_FILE="${BLOCK_DISCV5_RULES:-/etc/iptables.rules}"
LOG_FILE="${BLOCK_DISCV5_LOG:-/home/peter/base/block-bad-discv5.log}"
LOCK_FILE="${BLOCK_DISCV5_LOCK:-/home/peter/base/block-bad-discv5.lock}"

log() { echo "$(date -Iseconds) $*" >> "$LOG_FILE"; }

# 同一时刻只允许一个实例运行，避免多实例 -D/-I 竞态导致某 IP 规则被删后未及时插回
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "跳过本轮：上一轮仍在运行（flock 未获取锁）"
    exit 0
  fi
else
  # 无 flock 时用 mkdir 做简易锁（目录创建原子）
  LOCK_DIR="${LOCK_FILE}.d"
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    log "跳过本轮：上一轮仍在运行（等待锁）"
    exit 0
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
fi

# 到容器的链：优先 DOCKER-USER（在 Docker ACCEPT 之前），不存在则退回到 FORWARD
if sudo iptables -L DOCKER-USER -n &>/dev/null; then
  CHAIN_CONTAINER="DOCKER-USER"
else
  CHAIN_CONTAINER="FORWARD"
fi

# 同时匹配 "Bad discv5 packet" 与 id=全零；addr=IP 或 addr=IP:port
IPS=$(sudo docker logs "$CONTAINER" --tail "$TAIL" 2>&1 \
  | grep "Bad discv5 packet" \
  | grep "p2p=discv5 id=0000000000000000000000000000000000000000000000000000000000000000" \
  | grep -oE "addr=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(:[0-9]*)?" \
  | sed 's/addr=//' \
  | cut -d: -f1 \
  | sort -u)

[ -z "$IPS" ] && exit 0

# 已屏蔽 = 在 INPUT 或 DOCKER-USER/FORWARD 中已有 -s IP -j DROP 的源 IP（仅用于统计）
get_dropped_ips() { sudo iptables -L "$1" -n 2>/dev/null | awk '$1=="DROP" && $4~/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print $4}'; }
BLOCKED=$( ( get_dropped_ips INPUT; get_dropped_ips DOCKER-USER; get_dropped_ips FORWARD ) | sort -u )

total_ips=$(echo "$IPS" | wc -l)
already_blocked=$(comm -12 <(echo "$IPS") <(echo "$BLOCKED") | wc -l)

# 对本轮日志中出现的全部 IP 逐一「先删后插」到 raw PREROUTING/OUTPUT + INPUT + DOCKER-USER，确保每轮都重写所有规则
# raw 表最先执行，在 conntrack 之前 DROP，避免 ESTABLISHED 等被其它链先放行导致拦不住
count_raw=0
count_input=0
count_container=0
for ip in $IPS; do
  # raw 表：PREROUTING（入站先于 conntrack）、OUTPUT（出站到该 IP 也丢）
  sudo iptables -t raw -D PREROUTING -s "$ip" -j DROP 2>/dev/null || true
  sudo iptables -t raw -D OUTPUT -d "$ip" -j DROP 2>/dev/null || true
  if sudo iptables -t raw -I PREROUTING 1 -s "$ip" -j DROP 2>/dev/null; then
    count_raw=$((count_raw+1))
  fi
  sudo iptables -t raw -I OUTPUT 1 -d "$ip" -j DROP 2>/dev/null || true
  # 到本机：先删（若存在）再插到链首
  sudo iptables -D INPUT -s "$ip" -j DROP 2>/dev/null || true
  if sudo iptables -I INPUT 1 -s "$ip" -j DROP 2>/dev/null; then
    count_input=$((count_input+1))
  else
    log "WARN iptables INPUT 失败: $ip"
  fi
  # 到容器：先删（若存在）再插到链首
  sudo iptables -D "$CHAIN_CONTAINER" -s "$ip" -j DROP 2>/dev/null || true
  if sudo iptables -I "$CHAIN_CONTAINER" 1 -s "$ip" -j DROP 2>/dev/null; then
    count_container=$((count_container+1))
  else
    log "WARN iptables $CHAIN_CONTAINER 失败: $ip"
  fi
  log "增加/改写 iptables: $ip (raw+INPUT+$CHAIN_CONTAINER)"
done

# 每轮都持久化（因每轮都改写了规则）
if [ "$total_ips" -gt 0 ]; then
  sudo sh -c "iptables-save > $RULES_FILE" 2>/dev/null || true
  log "本轮改写 $total_ips 个 IP 的规则（raw PREROUTING $count_raw 条，INPUT $count_input 条，$CHAIN_CONTAINER $count_container 条；其中 $already_blocked 个本轮前已有规则已重写）；到容器链=$CHAIN_CONTAINER"
fi
