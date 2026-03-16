#!/bin/bash
# Apply NUMA bindings to lighthouse, geth, op-reth, op-node
# Run on remote host 38.102.126.30
# Usage: from x402sdk/ or service/: ./apply-numa-bindings.sh
#
# NUMA layout (current target, node2 has 0 MB):
#   node0: cpus 0-7         64GB  → op-reth
#   node1: cpus 8-15        32GB  → op-reth
#   node2: cpus 16-23        0GB  → op-reth CPUs + op-node CPUs (memory from node0)
#   node3: cpus 24-31       32GB  → lighthouse + geth

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_SYSTEMD="${TARGET_SYSTEMD:-/etc/systemd/system}"
COMPOSE_DIR="${COMPOSE_DIR:-/home/peter/base}"

echo "=== Applying NUMA bindings ==="
echo "Source: $SCRIPT_DIR"
echo "Target: $TARGET_SYSTEMD"
echo ""

# 1. lighthouse (node3)
echo "Installing lighthouse.service..."
sudo cp "$SCRIPT_DIR/lighthouse.service" "$TARGET_SYSTEMD/lighthouse.service"
sudo systemctl daemon-reload

# 2. geth (node3)
echo "Installing geth.service..."
sudo cp "$SCRIPT_DIR/geth.service" "$TARGET_SYSTEMD/geth.service"

# 3. base-op-reth-native (node0+node1+node2 CPUs, node0+node1 memory)
echo "Installing base-op-reth-native.service..."
sudo cp "$SCRIPT_DIR/base-op-reth-native.service" "$TARGET_SYSTEMD/base-op-reth-native.service"

sudo systemctl daemon-reload

# 4. op-node (Docker) - restart, then apply cpuset via docker update
echo "Restarting op-node..."
cd "$COMPOSE_DIR"
# Copy NUMA note if present
if [ -f "$SCRIPT_DIR/docker-compose-op-reth-numa.yml" ] && [ "$SCRIPT_DIR/docker-compose-op-reth-numa.yml" != "$COMPOSE_DIR/docker-compose-op-reth-numa.yml" ]; then
  sudo cp "$SCRIPT_DIR/docker-compose-op-reth-numa.yml" "$COMPOSE_DIR/"
fi
sudo docker compose -f docker-compose-op-reth-home.yml up -d op-node --force-recreate
[ -x "$SCRIPT_DIR/apply-op-node-numa.sh" ] && "$SCRIPT_DIR/apply-op-node-numa.sh"

# 5. Restart services (order matters: geth first, then lighthouse, then op-reth)
echo "Restarting geth..."
sudo systemctl restart geth.service
sleep 5

echo "Restarting lighthouse..."
sudo systemctl restart lighthouse.service
sleep 3

echo "Restarting base-op-reth-native..."
sudo systemctl restart base-op-reth-native.service

echo ""
echo "=== Verify ==="
echo "lighthouse: $(systemctl is-active lighthouse.service)"
echo "geth:       $(systemctl is-active geth.service)"
echo "op-reth:    $(systemctl is-active base-op-reth-native.service)"
echo "op-node:    $(docker ps --filter name=base-op-node --format '{{.Status}}')"
