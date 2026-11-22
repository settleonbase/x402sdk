# Lab G2 build-phase tools (ops only; no production code)

Candidate: Lab daemon `0160a08544013483ae992c77ee60e9aeb73ca811` (dist manifest sha256 `45ff2874a9f1117f6b8c0a6ad3f8daf38800a027bbb174c6bcb11de4127e0f68`, 216 files). This branch has that commit as its parent and adds only this directory.
These two tools are used once, for the retry of the G2 build step after `npm ci` had already finished from the lock file in the new release directory. They are NOT executed anywhere yet; running them needs the PM's written RELEASE of this branch and the G2 approval already given. Delivery to a host is by `git` from GitHub only; the host checks `HEAD` and the SHA-256 of each file against the review before use.

| file | kind |
|---|---|
| `verify-npm-tree-readonly.js` | read-only: installed `node_modules` against the lock file (no network, no writes, no child processes); last line `NPMTREE_OK` or `NPMTREE_FAIL` |
| `lab-g2-build-phase-only.sh` | EXECUTION (G2, build phase only): checks, then `npm run build`, then the verification part of the bound `lab-g2-build.sh` |

## What the wrapper does
- It never runs `npm ci`, never deletes the npm cache (line 47 of `lab-g2-build.sh` is not run), never retries. Any failure stops it in place and leaves everything as it is.
- It uses the OLD bound ops checkout (commit `ce956a78`, directory `ops/lab-g2g3-2026-11-22`) through `OPS_DIR`: `common.env.sh` (sha256 `2ede81c8b74960ff6efd93e6f175d4b76eee0e7b0fb2d66cf6c8d6c1739b03a0`) and `lab-g2-build.sh` (sha256 `2b8e1942700754fc2f17ec95b71363ba102dab182fe9f76959fe872d7dddc7e3`) are checked by hash before anything is read from them, and the tree of that checkout must be `a9274a9af0c735071004209672bd1ea8d40b9239` with no local changes. Files of any other ops checkout are not used.
- Start gate (read-only, enforced by the script; it exits without having changed anything if it is not met): three samples 5 s apart, each needs `MemAvailable - 1,228,800 - (2,097,000 - RSS of the other service) >= 1,000,000` (kB) and that RSS `<= 700,000` kB, with the same main pid throughout; the clock must be outside +-120 s around second 157 of every 10-minute cycle (the periodic oracle job), checked before and after the samples. It runs right before the build, after the read-only checks below.
- Before the build: site file check, pinned helpers, node/npm versions, the release directory is exactly what `npm ci` left (pinned commit and tree, no `dist`, nothing modified except the two logs), lock file hash, `verify-npm-tree-readonly.js` (hash pinned) must end with `NPMTREE_OK`, and `node node_modules/typescript/lib/tsc.js --version` must print `Version 5.8.3`.
- The verification part (216-file comparison, change list against the running dist, group and permission checks, `node --check`) is lines 28-46 of the bound `lab-g2-build.sh`, extracted at run time; the 19 lines must hash to `0e0903dc749c7706ecec38be34badba17a1b59306c1bce601d5ad38399bf3dd7` before they run. Nothing is re-implemented.
- Success prints `G2_BUILD_OK rev <REV> tree <TREE> files 216 manifest <DIST_SHA>`.

## Limits (the wrapper reads them back from its own cgroup and refuses otherwise)
Start inside a transient scope with `MemoryMax=1200M` (1,258,291,200 bytes; systemd's `M` is MiB), `MemorySwapMax=0`, `CPUWeight=10`, `IOWeight=10`, and `NODE_OPTIONS=--max-old-space-size=1024` (the value of `HEAP_MB` in the file); run it with `nice -n 19 ionice -c3` as the operator account (not root). Environment: `SITE_ENV`, `OPS_DIR`, `HOME`, `NODE_OPTIONS`. `verify-npm-tree-readonly.js` is read from the directory of the wrapper (hash pinned).

Site file: besides the usual fields it must contain `CLAIM_UNIT` (the name of the other service's unit; field name only here, the value stays in the private site file). The start gate takes the main pid of that unit from `systemctl`.

## 1 GB stop-line watcher (operator steps; the watcher starts BEFORE the wrapper)
The line is 1,000,000 kB of `MemAvailable` and is not relaxed. The watcher only ever stops the build scope; it never touches the other services.
1. Before anything starts, note the main pids of the other service (`CLAIM_PID`) and of the running Lab (`LAB_PID`), and choose the name of the build scope (`SCOPE`, the value of `--unit` plus `.scope`) and a log file outside the repository.
2. Start the watcher (below) in its own terminal as the operator account and note its pid (`$!`). Check that the pid is alive and that the log shows a first line before the wrapper is started. If the watcher is not running, the build is not started.
3. Start the wrapper in the transient scope as described above.
4. The watcher reads every second: `MemAvailable`; and every 5 seconds writes one log line with the UTC time, `MemAvailable`, the scope's `memory.current`, its anonymous memory (`anon` in `memory.stat`), its `memory.events` (look at `oom` and `oom_kill`), and the RSS of the other service and of the Lab (`VmRSS`). A `MemAvailable` below the line, or one that cannot be read as a number, stops the build scope: the pids in the scope's `cgroup.procs` are logged first, the scope is stopped by name only if none of them is `CLAIM_PID` or `LAB_PID`, otherwise nothing is stopped and the log says so. If the scope does not exist yet, the log says so and the watcher keeps watching, so a scope started later under the line is stopped at once.
5. When the wrapper has ended (success or not), stop the watcher by the pid noted in step 2 (check with `ps -p <pid> -o args=` that it is the watcher), keep the log with the readings and times, and record both in the receipt.
```
SCOPE=<scope unit name>.scope; LOG=<log file>; CLAIM_PID=<pid>; LAB_PID=<pid>; i=0
rss() { awk '/^VmRSS:/ {print $2}' "/proc/$1/status" 2>/dev/null; }
while :; do
  a=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo); case "$a" in ''|*[!0-9]*) a=0;; esac
  cg=$(systemctl show "$SCOPE" -p ControlGroup --value 2>/dev/null); cgd=/sys/fs/cgroup$cg; [ -n "$cg" ] && [ -d "$cgd" ] || cgd=
  if [ $((i % 5)) -eq 0 ]; then
    { printf '%s MemAvailable=%s' "$(date -u +%FT%TZ)" "$a"
      [ -z "$cgd" ] || printf ' scope.current=%s scope.anon=%s scope.events="%s"' "$(cat "$cgd/memory.current")" "$(awk '$1=="anon" {print $2}' "$cgd/memory.stat")" "$(tr '\n' ' ' <"$cgd/memory.events")"
      printf ' claimRSS=%s labRSS=%s\n' "$(rss "$CLAIM_PID")" "$(rss "$LAB_PID")"; } >>"$LOG"
  fi
  if [ "$a" -lt 1000000 ]; then
    if [ -z "$cgd" ]; then echo "$(date -u +%FT%TZ) MemAvailable=$a kB below the line, no build scope" >>"$LOG"
    elif grep -qxE "$CLAIM_PID|$LAB_PID" "$cgd/cgroup.procs"; then echo "$(date -u +%FT%TZ) MemAvailable=$a kB below the line, REFUSED: the scope holds a protected pid" >>"$LOG"
    else echo "$(date -u +%FT%TZ) MemAvailable=$a kB below the line, stopping $SCOPE, pids: $(tr '\n' ' ' <"$cgd/cgroup.procs")" >>"$LOG"; sudo -n systemctl stop "$SCOPE"; fi
  fi
  i=$((i + 1)); sleep 1
done
```
A kill by the cgroup, touching the line, or a compiler crash ends the attempt and is reported; nothing is retried. If a `dist` directory already exists in the release directory the wrapper refuses to run and never removes it.

## Local checks (no production)
Run against a copy of the bound ops directory with stubbed `sudo`, `getent` and cgroup files: positive run `G2_BUILD_OK` with 216 files and manifest `45ff2874...`; each of these stops with a non-zero exit and no `dist` left behind: wrong or missing `NODE_OPTIONS`, `memory.max` of 960M, swap not zero, missing or tampered check script, one installed package version changed, `typescript/lib/tsc.js` removed, simulated compiler crash (exit 134), tampered `lab-g2-build.sh`, tampered `common.env.sh`, a stray file in the release directory, a changed hash of the extracted text; the start gate: low `MemAvailable`, RSS over 700,000 kB, one kB below and exactly at the boundary (3,625,800 passes with RSS 700,000), unreadable or non-numeric main pid, a second sample that drops, clock at or inside the window edges and outside it. The BSD `find` used locally has no `-perm /022`, so that one line was not exercised there.

The watcher loop above was run against stub `/proc`, cgroup and `systemctl` files: no scope yet (logs, does not stop), scope present and memory fine (logs, does not stop), below the line with a build-only scope (logs the pids, stops the scope), below the line with a scope holding a protected pid (refuses and says so), unreadable `MemAvailable` (treated as below the line), below the line with no scope (logs). It has not been run on a real host.
