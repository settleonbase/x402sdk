#!/usr/bin/python3 -I
"""READ-ONLY. Prints ONE JSON line with the manifest fields the G3 scripts compare, read from the REAL keys of a Lab payout state directory (writer: labClPayoutStateStore.ts, segmented manifest):
version, generation, previousGeneration, pending.count, consumed.lines, scalars.settledBatchCount / realtimeCursor / historyCursor, and whether a wal/ directory exists.
usage: manifest-fields.py <state dir (…/payout-state.v2)>   exit 0 = every compared value is present and a non-negative integer (or a string for the generation ids); exit 3 + a message otherwise (nothing is guessed, no null is printed)."""
import json, os, sys
if len(sys.argv) != 2: print(__doc__); sys.exit(2)
d = sys.argv[1]
try: m = json.load(open(os.path.join(d, 'manifest.json')))
except Exception as e: print('MANIFEST_FIELDS_ERROR: manifest unreadable ' + type(e).__name__); sys.exit(3)
def nn(v): return isinstance(v, int) and not isinstance(v, bool) and v >= 0
sc = m.get('scalars') if isinstance(m.get('scalars'), dict) else {}
pend = m.get('pending') if isinstance(m.get('pending'), dict) else {}
cons = m.get('consumed') if isinstance(m.get('consumed'), dict) else {}
out = {'version': m.get('version'), 'generation': m.get('generation'), 'previousGeneration': m.get('previousGeneration'),
       'pending': pend.get('count'), 'consumed': cons.get('lines'), 'settled': sc.get('settledBatchCount'),
       'realtimeCursor': sc.get('realtimeCursor'), 'historyCursor': sc.get('historyCursor'), 'wal': os.path.isdir(os.path.join(d, 'wal'))}
bad = []
if out['version'] not in (2, 3): bad.append('version')
if not isinstance(out['generation'], str) or not out['generation']: bad.append('generation')
if out['previousGeneration'] is not None and not isinstance(out['previousGeneration'], str): bad.append('previousGeneration')
for k in ('pending', 'consumed', 'settled'):
    if not nn(out[k]): bad.append(k)
if bad: print('MANIFEST_FIELDS_ERROR: missing or invalid: ' + ','.join(bad) + ' (expected keys: version, generation, previousGeneration, pending.count, consumed.lines, scalars.settledBatchCount)'); sys.exit(3)
print(json.dumps(out, sort_keys=True)); sys.exit(0)
