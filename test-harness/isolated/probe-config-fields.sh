#!/bin/bash
# 只读辅助：在临时 HOME 中加载已编译的服务模块，打印首个失败的源码行，用于确定合成 .master.json 必填字段。
# 用法：probe-config-fields.sh <build-out 目录> <HOME 目录> <模块相对路径>
BUILD="$1"; ISO="$2"; MOD="$3"
node -e "const g=require('./guard.cjs');g.assertServiceLaunchAllowed();g.assertTestHome(process.env.HOME)" || exit 1
cd "$BUILD/.." && HOME="$ISO" BASE_RPC_URL=http://127.0.0.1:9 CONET_RPC_URL=http://127.0.0.1:9 timeout 25 node -e "require('./$(basename "$BUILD")/$MOD')" 2>&1 | grep -E "TypeError|Error:|\.js:[0-9]+$" -A1 | head -6
