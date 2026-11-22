#!/usr/bin/python3 -I
"""D10 gate-value reader (READ-ONLY). Computes the one-batch first-gate value N = persisted settledBatchCount + 1 from the committed manifest of a Lab CL payout v2 state
directory, and cross-checks it against the chain: the Lab wallet's nonce (latest and pending, every RPC given) must equal settledBatchCount (one withdrawNative per settled batch).
It also reports whether the manifest holds an in-flight record. It writes nothing and prints no secret.
usage: gate-value-ro.py <payout-state.v2 dir> --lab <0x Lab wallet> --rpc <url> [--rpc <url> ...] [--expect-count C]
Output lines: COUNT=<n>, NONCE_LATEST=<n>@<rpc>, NONCE_PENDING=<n>@<rpc>, INFLIGHT=yes|no, N=<count+1>, and the last line GATE_OK or GATE_STOP:<reason>.
GATE_OK only if: count is a non-negative integer, no in-flight record (no scalars.inFlightWithdraw, no manifest.inFlightKeys, empty inflight dir), every nonce latest==pending==count,
and --expect-count (when given, used for the pre-start re-read) equals the count. Exit 0 on GATE_OK, 3 on GATE_STOP, 2 on usage."""
import json, os, re, sys, urllib.request
a = sys.argv[1:]
if not a or a[0].startswith('--'): print(__doc__); sys.exit(2)
d = a[0]; lab = None; rpcs = []; expect = None; i = 1
while i < len(a):
    if a[i] == '--lab' and i + 1 < len(a): lab = a[i + 1]; i += 2
    elif a[i] == '--rpc' and i + 1 < len(a): rpcs.append(a[i + 1]); i += 2
    elif a[i] == '--expect-count' and i + 1 < len(a): expect = a[i + 1]; i += 2
    else: print(__doc__); sys.exit(2)
if not (lab and re.fullmatch(r'0x[0-9a-fA-F]{40}', lab) and rpcs): print(__doc__); sys.exit(2)
if expect is not None and not re.fullmatch(r'0|[1-9][0-9]*', expect): print(__doc__); sys.exit(2)
stop = []
def fail(r): stop.append(r)
try: m = json.load(open(os.path.join(d, 'manifest.json')))
except Exception as e: print('GATE_STOP:manifest unreadable ' + type(e).__name__); sys.exit(3)
sc = m.get('scalars') or {}; cnt = sc.get('settledBatchCount')
if not (isinstance(cnt, int) and not isinstance(cnt, bool) and cnt >= 0): print('COUNT=%r' % (cnt,)); print('GATE_STOP:settledBatchCount is not a non-negative integer'); sys.exit(3)
print('GENERATION=' + str(m.get('generation'))); print('COUNT=%d' % cnt)
inf = (sc.get('inFlightWithdraw') is not None) or ('inFlightKeys' in m)
idir = os.path.join(d, 'inflight'); entries = sorted(os.listdir(idir)) if os.path.isdir(idir) else []
if entries: inf = True
print('INFLIGHT=' + ('yes' if inf else 'no')); 
if inf: fail('an in-flight record or inflight entries exist (see r3c section 4: run the recovery step first)')
def nonce(url, tag):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getTransactionCount', 'params': [lab, tag]}).encode()
    r = json.load(urllib.request.urlopen(urllib.request.Request(url, data=body, headers={'content-type': 'application/json', 'user-agent': 'gate-ro/1'}), timeout=30))
    if 'result' not in r: raise RuntimeError(str(r.get('error'))[:80])
    return int(r['result'], 16)
for u in rpcs:
    for tag in ('latest', 'pending'):
        try: n = nonce(u, tag)
        except Exception as e: print('NONCE_%s=UNKNOWN@%s %s' % (tag.upper(), u, type(e).__name__)); fail('nonce read failed on ' + u); continue
        print('NONCE_%s=%d@%s' % (tag.upper(), n, u))
        if n != cnt: fail('nonce %s %d != settledBatchCount %d on %s' % (tag, n, cnt, u))
if expect is not None and int(expect) != cnt: fail('settledBatchCount %d differs from --expect-count %s (changed since the first read)' % (cnt, expect))
print('N=%d' % (cnt + 1))
if stop: print('GATE_STOP:' + '; '.join(stop)); sys.exit(3)
print('GATE_OK'); sys.exit(0)
