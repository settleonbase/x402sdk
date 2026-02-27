#!/bin/bash
# 修复 op-node 与 reth 之间的 JWT 认证问题
# reth 报错: "Invalid JWT: Authorization header is missing or invalid"
#
# 用法:
#   仅诊断: REGEN=0 ./fix-jwt-auth.sh
#   诊断+修复: ./fix-jwt-auth.sh  或  REGEN=1 ./fix-jwt-auth.sh
#
# 在服务器上执行: bash fix-jwt-auth.sh

set -e

JWT_DIR="${JWT_DIR:-/home/peter/base/jwt}"
JWT_FILE="$JWT_DIR/jwt.hex"
REGEN="${REGEN:-1}"

echo "=== JWT 认证诊断/修复 ==="
echo "JWT 文件: $JWT_FILE"
echo ""

# 1. 检查当前 JWT 文件
echo "1. 检查 JWT 文件..."
if [ ! -f "$JWT_FILE" ]; then
  echo "   [错误] 文件不存在"
  exit 1
fi

BYTES=$(wc -c < "$JWT_FILE")
echo "   文件字节数: $BYTES (期望 64，若为 65 通常含换行)"
HEX=$(cat "$JWT_FILE" | tr -d '\n\r ')
HEX_LEN=${#HEX}
echo "   去空白后长度: $HEX_LEN"
if [ "$HEX_LEN" -ne 64 ]; then
  echo "   [问题] 应为 64 个十六进制字符"
fi
if ! echo "$HEX" | grep -qE '^[0-9a-fA-F]{64}$'; then
  echo "   [问题] 含非十六进制字符"
fi
echo ""

# 2. 若仅诊断则退出
if [ "$REGEN" = "0" ]; then
  echo "2. 仅诊断模式，不修改。若要修复请运行: REGEN=1 $0"
  exit 0
fi

# 3. 备份并重新生成（无换行）
echo "2. 重新生成 JWT..."
cp -a "$JWT_FILE" "$JWT_FILE.bak.$(date +%Y%m%d%H%M%S)"
openssl rand -hex 32 | tr -d '\n' > "$JWT_FILE.tmp"
mv "$JWT_FILE.tmp" "$JWT_FILE"
chmod 600 "$JWT_FILE"
chown peter:peter "$JWT_FILE" 2>/dev/null || true
echo "   已生成，新长度: $(wc -c < "$JWT_FILE")"
echo ""

# 4. 重启
echo "3. 重启 op-reth 和 op-node..."
COMPOSE_DIR="/home/peter/base"
COMPOSE_FILE=""
for f in "docker-compose-op-reth-home.yml" "docker-compose.yml"; do
  [ -f "$COMPOSE_DIR/$f" ] && COMPOSE_FILE="$COMPOSE_DIR/$f" && break
done
if [ -n "$COMPOSE_FILE" ]; then
  (cd "$COMPOSE_DIR" && docker compose -f "$(basename "$COMPOSE_FILE")" restart op-reth op-node)
  echo "   已重启"
else
  echo "   [提示] 请手动: docker compose restart op-reth op-node"
fi
echo ""
echo "完成。观察 reth 日志: docker logs -f base-op-reth 2>&1 | grep -i jwt"
