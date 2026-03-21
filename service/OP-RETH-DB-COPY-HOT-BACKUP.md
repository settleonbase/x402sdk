# op-reth MDBX hot backup (`db copy`)

## 简体中文要点

- **必须在 `tmux` 里跑**（或 `screen`），避免 SSH 断开把 `db copy` 一起杀掉。
- **日志**：用 `tee -a "$HOME/db-copy.log"` 把标准输出/错误**追加**到文件；看**末尾**用 `tail -n 200 "$HOME/db-copy.log"` 或 `tail -f`。
- **断点续拷**：不支持；中断后的目录不要当可用库，可 `mv` 成 `*.partial-*` 留档，再换**新目录名**全量重拷。
- **热备会不会「写源」？** 见下文「热备份与一致性检查」：`mdbx_env_copy` 只写**目标**；失败往往来自**启动 CLI 时**对源库跑 `check_consistency`，若判定要修 static，会需要 **writer**，与只读打开冲突。

---

## 热备份与一致性检查（排查结论）

### 设计意图：拷盘写哪里？

- **`db copy`** 的核心是 **`mdbx_env_copy`**：把源 **`db/`（MDBX）** 拷到 **`DEST`**。  
- **正常设计**：对源 **`db` + static-files 应为只读**；**不应**与正在运行的节点一起「第二个写者」去写同一套 `op-reth-static`。  
- 因此：**不是因为「两个 op-reth 同时写 static」才报错**；你的日志是 **单进程在只读环境下试图执行需要写权限的修复步骤**。

### 你看到的两条错误在说什么？

1. **`File is in an inconsistent state`**  
   在 **`check_consistency`（read_only=true）** 阶段，存储被认为不一致，命令直接退出（常见于较严/较早逻辑）。

2. **`Unwinding static file segment` → `cannot get a writer on a read-only environment`**  
   一致性检查判定 Headers 段需要 **回退 static file 一段**（**修改源上的 static files**），但当前 CLI 用 **只读** 打开了 static provider，**拿不到 writer**，于是失败。  
   这不是「热备想往备份目录写」失败，而是 **「先校验/自愈源数据」这一步想写源，与只读冲突**。

### 上游 CLI 设定（reth / op-reth）

在 **paradigmxyz/reth** 的 `crates/cli/commands/src/db/mod.rs` 里，**`db copy` 使用 `AccessRights::RO`**，与其他只读子命令一样会先走 **`EnvironmentArgs::init` → `create_provider_factory`**。  
其中会对 **非 `RoInconsistent`** 模式做 **`static_file_provider().check_consistency(...)`**。  
较新版本在外层对 **只读库** 若发现不一致，可能改为 **告警后继续**（不跑 pipeline unwind）；但若 **`check_consistency` 内部**仍尝试 unwind static，仍可能触发你这类 **read-only / writer** 错误（与构建版本有关）。

`db stats` 等子命令若带 **`--skip-consistency-checks`**，会使用 **`RoInconsistent`** 以**跳过**上述一致性块；**`db copy` 当前没有等价官方 flag**。

### 可行对策（按推荐顺序）

1. **升级 op-reth** 到较新主线/RC，观察是否已避免在只读 copy 路径里对 static 做必须写盘的 unwind。  
2. **停节点 → 让存储自愈**：停止 `op-reth` 后**正常启动一次**（RW），或按版本文档使用可写模式下的 repair / unwind，使 Headers 与 DB 对齐后，再 **`db copy -p`**。  
3. **冷备**：停节点后拷贝（磁盘快照 / `db copy`），避免运行中与 MDBX 并发。  
4. **自建 fork**：把 `db copy` 的 access 改为与 `static-file-header` 类似使用 **`RoInconsistent`**（跳过该一致性块）——**有风险**：副本可能基于未完全校验的视图，仅适合知情场景。

---

Use **`tmux`** so SSH disconnect does not kill the long-running copy. Log everything to **`db-copy.log`** for post-mortem (OOM, disk full, errors).

## One-shot: tmux + log file

```bash
# 1) New session (pick a name you remember)
tmux new -s op-reth-db-copy

# 2) Inside tmux: run copy, append stdout/stderr to log (also see on screen)
LOG="$HOME/db-copy.log"
DEST="/media/sda/baseBackup-$(date +%Y%m%d-%H%M%S)"   # unique path per run; mdbx often needs absent target

/media/sda/bin/op-reth-v1.11.3-rc.3 db \
  --datadir /home/peter/base/op-reth \
  --datadir.static-files /media/sda/base/op-reth-static \
  --chain base \
  copy -p "$DEST" \
  2>&1 | tee -a "$LOG"

# 3) Detach (copy keeps running): Ctrl+B then D
# 4) Reattach later: tmux attach -t op-reth-db-copy
```

**Note:** `db copy` copies the **MDBX `db/`** only, not `static-files`. Keep the same `--datadir` / `--datadir.static-files` as the live node so chain context matches.

## Inspect the **end** of `db-copy.log` (after interrupt or failure)

```bash
# Last ~200 lines (adjust -n as needed)
tail -n 200 "$HOME/db-copy.log"

# Or follow live while attached in another SSH session
tail -f "$HOME/db-copy.log"
```

When asking for help, paste **the last 80–200 lines** of `db-copy.log` plus `dmesg | tail -50` if you suspect OOM.

## Optional: lower I/O priority (less impact on live op-reth)

```bash
ionice -c2 -n7 nice -n 10 /media/sda/bin/op-reth-v1.11.3-rc.3 db ...
```

## Do not rely on partial destination

Interrupted `copy` output is **not** resumable with `db copy`. Rename partial dirs if you want to keep them for forensics only:

```bash
mv /media/sda/baseBackup /media/sda/baseBackup.partial-"$(date +%Y%m%d-%H%M%S)"
```

Then start a **new** full `copy` to a **new** `DEST` path.

## Automated (detached tmux)

On the Linux node, from this repo’s `service/` directory:

```bash
chmod +x run-op-reth-db-copy-tmux.sh
./run-op-reth-db-copy-tmux.sh
# override: DEST=/media/sda/myBackup LOG=$HOME/db-copy.log ./run-op-reth-db-copy-tmux.sh
```

## Related

- Disk layout: `DISK-IO-EVALUATION.md`
- Binary extract: `extract-op-reth-to-media-sda.sh`
