#!/bin/bash
# G3 post-cutover READ-ONLY readbacks (v2, revised after review 61a82693; NOT EXECUTED). Run at +2, +10, +30 and +60 minutes after t_start.txt. Reads only; writes nothing but stdout (redirect to a file under $W yourself).
# Delivery template (ADDENDUM-1 s4): T_CONV anchor; the FIRST withdrawNative ok of each line AFTER T_CONV (tx hash, block, amount, pool-event and VDR-event amounts); cursors/pending/consumed/settledBatchCount;
# runtime state incl. memory.peak and file/anon (the first hour after L2, every 5 minutes: run it from a loop or by cron as asked); S1-S4 stay the run-time stop conditions (separate field helpers).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); . "$HERE/common.env.sh"
SV=$(site_verify) || { echo "site configuration: $SV" >&2; exit 1; }
T0=$(cat $W/t_start.txt); TCONV=$(cat $W/t_conv.txt)
echo "#R_TIME $(date -u +%FT%T.%NZ) T_START=$T0 T_CONV=$TCONV"
P=$(systemctl show $DUNIT -p MainPID --value)
systemctl show $DUNIT -p ActiveState,SubState,MainPID,InvocationID,NRestarts,WorkingDirectory,MemoryMax,MemorySwapMax --no-pager | tr '\n' ' '; echo
echo "cwd: $($SUDO readlink /proc/$P/cwd)"; echo "NODE_OPTIONS in process: $($SUDO sh -c "tr '\0' '\n' </proc/$P/environ" | grep '^NODE_OPTIONS=')"
echo "start line: $($SUDO journalctl -u $DUNIT --since "$T0" --utc --no-pager -o cat | grep 'starting dual-cursor' | head -1 | cut -c1-280)"
echo "WAL lines: $($SUDO journalctl -u $DUNIT --since "$T0" --utc --no-pager -o cat | grep -E 'WAL mode:' | head -3 | cut -c1-260 | tr '\n' '|')"
# In WAL mode manifest.json is rewritten only when a snapshot is committed (default every 10 minutes): these values are the LAST SNAPSHOT, not live. Live progress is the journal below (scan-summary / flush-summary / withdrawNative lines).
echo "manifest (LAST SNAPSHOT, not live; B2 real keys pending.count / consumed.lines): $(manifest_json 2>&1 | tail -1)"
echo "snapshot ALERT lines in the journal (a successful snapshot logs nothing; its sign is the manifest generation above changing): $($SUDO journalctl -u $DUNIT --since "$T0" --utc --no-pager -o cat | grep -i 'snapshot' | grep -c ALERT)"
echo "pending / consumed at the start (WAL line, realtime/history split is in the flush-summary lines): $($SUDO journalctl -u $DUNIT --since "$T0" --utc --no-pager -o cat | grep 'WAL mode: snapshotSeq' | head -1 | cut -c1-200)"
echo "last flush-summary (live): $($SUDO journalctl -u $DUNIT --since "$T0" --utc --no-pager -o cat | grep 'flush-summary' | tail -1 | cut -c1-260)"
echo "== journal since T_START (scan/flush/payment/alert lines)"
$SUDO journalctl -u $DUNIT --since "$T0" --utc --no-pager -o short-iso | grep -E 'scan-summary|flush inspect|flush-summary|withdrawNative|tick error|HALT|ALERT|unconfirmed=[1-9]|fetchFailed=[1-9]|paused=1|tipGap|snapshot' | cut -c1-230 | tail -50
echo "== first withdrawNative ok per line AFTER T_CONV ($TCONV)"
for LINE in realtime history; do
  L=$($SUDO journalctl -u $DUNIT --since "$T0" --utc --no-pager -o short-iso | awk -v t="$TCONV" -v l="line=$LINE" '$1>t && /withdrawNative sent via signer/ && $0 ~ l {print; exit}')
  H=$(echo "$L" | grep -o 'tx=0x[0-9a-fA-F]\{64\}' | cut -d= -f2)
  if [ -z "$H" ]; then echo "$LINE: no payment after T_CONV yet"; continue; fi
  echo "$LINE: $(echo "$L" | cut -c1-200)"
  R=$(curl -s -m 15 -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$H\"]}" $PUB)
  T=$(curl -s -m 15 -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionByHash\",\"params\":[\"$H\"]}" $PUB)
  python3 - "$R" "$T" "$POOL" "$VDR" <<'PY'
import json,sys
r=json.loads(sys.argv[1]).get("result"); t=json.loads(sys.argv[2]).get("result"); pool=sys.argv[3].lower(); vdr=sys.argv[4].lower()
if not r or not t: print("  receipt or tx not readable yet"); sys.exit(0)
inp=t["input"]; amount=int(inp[2+8+64:2+8+128],16)  # withdrawNative(address pool, uint256 amount): selector + 2 words
print("  block", int(r["blockNumber"],16), "status", r["status"], "from", t["from"], "to", t["to"], "calldata amount wei", amount)
w=hex(amount)[2:].rjust(64,"0"); ok_pool=ok_vdr=False
for lg in r.get("logs",[]):
    a=lg["address"].lower(); d=lg["data"][2:]
    if a==pool: print("  pool event: topic0", lg["topics"][0][:18], "data", lg["data"][:140]); ok_pool=ok_pool or (w in d)
    if a==vdr: print("  VDR event : topic0", lg["topics"][0][:18], "data", lg["data"][:140]); ok_vdr=ok_vdr or (w in d)
print("  amount word of the calldata found in a pool-event data:", ok_pool, "; in a VDR-event data:", ok_vdr, "(heuristic: the reviewer compares the decoded event amounts)")
PY
done
echo "== tick overlap check (between two consecutive realtime scan-summary lines exactly one flush-summary)"
$SUDO journalctl -u $DUNIT --since "$T0" --utc --no-pager -o short-iso | grep -E 'scan-summary line=realtime|flush-summary' | awk '/scan-summary line=realtime/{if(seen&&fs!=1)bad++; seen=1; fs=0; n++} /flush-summary/{fs++} END{print "scans="n" violations="bad+0}'
echo "== memory (VmHWM/VmRSS, cgroup events, memory.peak and the file/anon split)"
$SUDO grep -E '^(VmHWM|VmRSS):' /proc/$P/status | tr '\n' ' '; echo
CG=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/$P/cgroup)
echo "events: $($SUDO cat $CG/memory.events | tr '\n' ' ')"
echo "memory.peak=$($SUDO cat $CG/memory.peak) memory.current=$($SUDO cat $CG/memory.current)"
echo "memory.stat: $($SUDO grep -E '^(anon|file|file_dirty|file_writeback|inactive_file|active_file|kernel|shmem|sock) ' $CG/memory.stat | tr '\n' ' ')"
echo "== signer / claim / lab nonce"; systemctl show $SIGNER_UNIT -p MainPID,InvocationID,NRestarts --no-pager | tr '\n' ' '; echo; systemctl show $CLAIM_UNIT -p MainPID,InvocationID,NRestarts --no-pager | tr '\n' ' '; echo
echo "lab nonce latest: $(curl -s -m 15 -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionCount\",\"params\":[\"$LAB\",\"latest\"]}" $PUB | sed -E 's/.*"result": *"([^"]*)".*/\1/')"
echo "#R_END $(date -u +%FT%T.%NZ)"
