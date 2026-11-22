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

Stop line: 1 GB of available memory; a kill by the cgroup, touching the line, or a compiler crash ends the attempt and is reported; nothing is retried. If a `dist` directory already exists in the release directory the wrapper refuses to run and never removes it.

## Local checks (no production)
Run against a copy of the bound ops directory with stubbed `sudo`, `getent` and cgroup files: positive run `G2_BUILD_OK` with 216 files and manifest `45ff2874...`; each of these stops with a non-zero exit and no `dist` left behind: wrong or missing `NODE_OPTIONS`, `memory.max` of 960M, swap not zero, missing or tampered check script, one installed package version changed, `typescript/lib/tsc.js` removed, simulated compiler crash (exit 134), tampered `lab-g2-build.sh`, tampered `common.env.sh`, a stray file in the release directory, a changed hash of the extracted text; the start gate: low `MemAvailable`, RSS over 700,000 kB, one kB below and exactly at the boundary (3,625,800 passes with RSS 700,000), unreadable or non-numeric main pid, a second sample that drops, clock at or inside the window edges and outside it. The BSD `find` used locally has no `-perm /022`, so that one line was not exercised there.
