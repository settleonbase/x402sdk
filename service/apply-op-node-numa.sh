#!/bin/bash
# Apply NUMA cpuset to op-node: CPU node2 (16-23), 内存 node0 (node2 无内存)
cpuset="16-23"
cpuset_mems="0"
docker update --cpuset-cpus "$cpuset" --cpuset-mems "$cpuset_mems" base-op-node 2>/dev/null && echo "op-node cpuset applied (cpus=$cpuset mems=$cpuset_mems)" || echo "op-node not running"
