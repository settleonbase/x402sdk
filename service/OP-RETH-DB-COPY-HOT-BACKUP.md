# op-reth MDBX hot backup (`db copy`)

## 简体中文要点

- **必须在 `tmux` 里跑**（或 `screen`），避免 SSH 断开把 `db copy` 一起杀掉。
- **日志**：用 `tee -a "$HOME/db-copy.log"` 把标准输出/错误**追加**到文件；看**末尾**用 `tail -n 200 "$HOME/db-copy.log"` 或 `tail -f`。
- **断点续拷**：不支持；中断后的目录不要当可用库，可 `mv` 成 `*.partial-*` 留档，再换**新目录名**全量重拷。

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
