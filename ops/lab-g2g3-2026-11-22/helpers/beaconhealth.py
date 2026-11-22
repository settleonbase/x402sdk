#!/usr/bin/env python3
# Read-only Beacon health read for the Lab payout daemon's Beacon (R13). GET only; no writes; no WebSocket; prints numbers and one verdict line.
# usage: python3 -I lab-beacon-health.py --beacon <http(s) URL>
# Exit 0 + last line BEACON_OK         : /eth/v1/node/syncing says is_syncing=false, is_optimistic=false, el_offline=false, and head epoch - finalized epoch <= 3
# Exit 3 + last line BEACON_NOT_OK     : it answered, but at least one of those conditions fails
# Exit 4 + last line BEACON_UNKNOWN    : unreachable, timeout, HTTP error, malformed or incomplete answer (UNKNOWN is never a pass)
# Exit 2                               : bad usage
import json, sys, urllib.request, urllib.parse

MAX_FINALITY_LAG_EPOCHS = 3

def get(base, path):
    with urllib.request.urlopen(base.rstrip('/') + path, timeout=15) as r:
        if r.status != 200:
            raise RuntimeError('http ' + str(r.status))
        return json.load(r)

def main(a):
    if '--beacon' not in a or a.index('--beacon') + 1 >= len(a):
        print('usage: --beacon <http(s) url>'); return 2
    base = a[a.index('--beacon') + 1]
    u = urllib.parse.urlparse(base)
    if u.scheme not in ('http', 'https') or not u.hostname:
        print('usage: --beacon <http(s) url>'); return 2
    print('beacon_host', u.netloc)
    try:
        s = get(base, '/eth/v1/node/syncing')['data']
        spe = int(get(base, '/eth/v1/config/spec')['data']['SLOTS_PER_EPOCH'])
        fin = int(get(base, '/eth/v1/beacon/states/head/finality_checkpoints')['data']['finalized']['epoch'])
        head = int(s['head_slot'])
        syncing, optimistic, el_off = s['is_syncing'], s['is_optimistic'], s['el_offline']
        for v in (syncing, optimistic, el_off):
            if not isinstance(v, bool):
                raise ValueError('non-boolean field')
    except Exception as e:
        print('BEACON_UNKNOWN', type(e).__name__); return 4
    lag = head // spe - fin
    print('head_slot', head, 'sync_distance', s.get('sync_distance'), 'head_epoch', head // spe, 'finalized_epoch', fin, 'finality_lag_epochs', lag,
          'is_syncing', syncing, 'is_optimistic', optimistic, 'el_offline', el_off)
    ok = (syncing is False) and (optimistic is False) and (el_off is False) and lag <= MAX_FINALITY_LAG_EPOCHS
    print('BEACON_OK' if ok else 'BEACON_NOT_OK'); return 0 if ok else 3

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
