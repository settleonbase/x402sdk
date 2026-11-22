# Lab payout G2/G3 window scripts (ops only; no production code)

Candidate under change: Lab daemon `0160a08544013483ae992c77ee60e9aeb73ca811` (dist manifest sha256 `45ff2874a9f1117f6b8c0a6ad3f8daf38800a027bbb174c6bcb11de4127e0f68`, 216 files). This branch has that commit as its parent and adds only this directory.
These files are NOT executed anywhere yet; running any of them needs the project owner's approval for the step (G2 build, G3 cutover) and the PM's written RELEASE of this branch. Delivery to a host is by `git` from GitHub only; check each file's SHA-256 against the list in the review page before use.

| file | kind |
|---|---|
| `common.env.sh` | constants and helpers (`gate_run`, `manifest_json`, `readv2_ro`, `oracle_gate_ok`) |
| `lab-g2-readonly-precheck.sh` | read-only: toolchain reproduces the running dist, file hashes, RPC and payment gates, GitHub reachability, disk, memory |
| `lab-g2-build.sh` | EXECUTION (G2): build `0160a085` on the host from GitHub, 216-file comparison |
| `lab-g3-cutover.sh` | EXECUTION (G3): `stop`, then a manual S1 check, then `swap-start`; `resume-check` and `status` are read-only |
| `lab-g3-post.sh` | read-only readbacks at +2/+10/+30/+60 min |
| `manifest-fields.py` | read-only: manifest fields from the REAL keys (`pending.count`, `consumed.lines`, ...) |
| `90-…proposed`, `94-…proposed` | drop-in proposals |
| `dist-*.expected.*` | expected file lists (216 / 189 files) and the change list |
| `selftest/` | no-production self-test (fixtures with the real manifest structure; gate exactness; static assertions) |

Rules built into `lab-g3-cutover.sh` (review 61a82693, PM rulings):
- the gate is true only for exit 0, last line exactly `GATE_OK`, and `INFLIGHT=no`;
- the old reader runs through `sudo` (the state directory is 0700) and is dry-run BEFORE the stop;
- after the stop ANY failure stops in place and reports; nothing restarts `df78e6b` by itself; the only automatic path back (`rollback_plain`) needs a proven clean plain version 2 state; a version 3 state is never rolled back by the script;
- no stop_switch and no Lab env file change (accepted deviation from the stop SOP); S1 identity is a manual check recorded in `$W/S1-OK` between the two phases;
- the oracle gate is judged again right before the start (wait if the next oracle run is within 120 s); segment times go to `$W/timings.txt`;
- the pre-WAL copy runs only with `COPY_APPROVED=yes` and a non-empty `COPY_APPROVAL_ID`, and is not a rollback path.

HELPERS (v4): `helpers/` holds the field's reviewed helper scripts byte-identical to the originals (`gate-value-ro.py`, `verify-state-digests-ro.py`, `envcheck.py`, `gatecheck.py`, `beaconhealth.py`, `lab-pool-beneficiary-check.py`); the scripts run them from this checkout (`HELPER_DIR`) and refuse to start unless every pinned helper matches its SHA-256 (`helpers_verify`). `readv2.js` (sha256 53536a0d...7833) is in its own commit and has a hash-bound review: REVIEW-readv2-js-53536a0d-readonly-2026-11-22 (sha256 475d80eb...) with ERRATUM (a6b5eb7b...), verdict pass, no blocking item.

v3 changes (review 98e19b2b, PM order): `stop` deletes any earlier S1-OK; `swap-start` accepts only the strict one-line S1-OK (`S1-OK by=<name> at=<UTC> result=OK consumed_delta=<n> settled_delta=<n> payments=<n>`) whose numbers equal `S1-DATA.env`; the 30-minute wait for an oracle-safe start moment now ends IN PLACE with an ALERT (no automatic restart of `df78e6b`); `resume-check` repeats the post-stop checks read-only after a transient not-green and writes the post-stop record only if everything is green; the post script no longer greps for snapshot log lines (a successful snapshot logs nothing).

v4 changes (review e9d2305c): `resume-check` and `swap-start` require the clean-stop record written by `stop` (`stop-fingerprint.txt`: Result=success + InvocationID + ExecMainExitTimestamp, all unchanged since), so an unclean stop (Result=timeout) can never be turned into a valid post-stop record; the S1-OK line count uses awk NR (exactly one line, also without a trailing newline); helpers are used from the checkout with pinned hashes.

v5 change: the old reader is run as `sudo -n node helpers/readv2.js <df78e6b dist/endpoint/labClPayoutStateStore.js> <state dir>` and the module is first checked against its pinned SHA-256 (0785bfb6...5e6, the entry of the reviewed 189-file list); a different file means the reader is not run.

v6 change (review c07a05c2 R2): the pinned helper hashes are verified at the start of `resume-check` and of `swap-start`, and once more right before the start, not only in the pre-check and in `stop` (a helper changed after the stop is refused). Rehearsal note: `unit_fingerprint` relies on systemd still reporting the last InvocationID and ExecMainExitTimestamp of a stopped unit; read them once on the real host (`systemctl show <unit> -p InvocationID -p ExecMainExitTimestamp -p Result`) before relying on it.

v7 (public-repository hygiene, PM order): this repository is public, so NOTHING about the host is written in it. Host paths, unit names, accounts, ports and the names of the host's existing drop-ins come from a private site file (`SITE_ENV=<file outside the repository>`; template `site.env.example`, placeholders only); `site_verify` refuses to run if a value is missing or still a placeholder. The 90 drop-in is a template (`@REL_NEW@`) rendered for the host and checked against its reviewed SHA-256 (a site value). `envcheck.py` and `gatecheck.py` read their three host values (state file, signer unit, Claim unit) from the environment instead of constants; they are the reviewed files with only those constants replaced (the exact diff is in the hand-over), all other helpers are byte-identical to the reviewed originals.

v8: the site file (a private file outside the repository) is read through sudo and must be owned by root with mode 0600; it is not sourced - only `NAME=value` lines for the site names are accepted, a line naming anything else (any fixed constant, any code) refuses the file; the fixed constants are defined after it is read. The hashes of the host's own private files are site values too. `swap-start` renders and verifies the 90 drop-in again right before it installs it. `helpers/lab-pool-beneficiary-check.py` contains two contract implementation addresses (pool and VDR implementations): they are public on-chain data and must be updated together with a contract upgrade.
