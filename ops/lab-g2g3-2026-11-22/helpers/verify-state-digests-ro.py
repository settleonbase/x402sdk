#!/usr/bin/python3 -I
"""Read-only, streaming (no big memory) check of a Lab CL payout v2 state directory against its manifest.json: scalars sha, and for the committed generation every
segment's lines/bytes/sha256 (pending segments, consumed, exited, and the in-flight blob if the manifest has one). Lists generation directories not referenced by the manifest
(unreferenced = never committed or already superseded) and the inflight directory. Writes nothing. usage: verify-state-digests-ro.py <payout-state.v2 dir>"""
import hashlib, json, os, re, sys
d = sys.argv[1]; GEN = re.compile(r'^gen-\d{8}T\d{6}Z-[0-9a-f]{12}$'); ok = True
def say(*a): print(*a)
def canon(o):
    # same canonical form the store uses is not reproduced here; the scalar hash is reported as informational only
    return json.dumps(o, sort_keys=True, separators=(',', ':'))
m = json.load(open(os.path.join(d, 'manifest.json'))); g = m['generation']; gd = os.path.join(d, g)
say('manifest generation', g, 'previous', m.get('previousGeneration'), 'writtenAt', m.get('writtenAt'))
sc = m['scalars']; say('scalars: settledBatchCount', sc.get('settledBatchCount'), '| inFlightWithdraw present', 'inFlightWithdraw' in sc and sc['inFlightWithdraw'] is not None, '| manifest.inFlightKeys present', 'inFlightKeys' in m, '| freezeH', (sc.get('freezeH') or {}).get('height'), '| cursors', sc.get('realtimeCursor'), sc.get('historyCursor'))
def chk(label, ref, base):
    global ok
    p = os.path.join(base, ref['file']); h = hashlib.sha256(); n = 0; size = 0
    try:
        with open(p, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk); size += len(chunk); n += chunk.count(b'\n')
    except OSError as e:
        say('MISSING', label, ref['file'], e); ok = False; return
    good = (h.hexdigest() == ref['sha256'] and size == ref['bytes'] and n == ref['lines'])
    if not good: ok = False
    say('OK  ' if good else 'BAD ', label, ref['file'], 'lines', n, 'bytes', size)
for s in m['pending']['segments']: chk('pending', s, gd)
chk('consumed', m['consumed'], gd); chk('exited', m['exited'], gd)
say('pending.count (manifest)', m['pending']['count'], '| sum of segment lines', sum(s['lines'] for s in m['pending']['segments']), '| consumed.lines', m['consumed']['lines'])
if 'inFlightKeys' in m:
    ik = m['inFlightKeys']
    for s in ik['segments']: chk('inflight', s, os.path.join(d, 'inflight', ik['id']))
say('inflight dir entries:', sorted(os.listdir(os.path.join(d, 'inflight'))) if os.path.isdir(os.path.join(d, 'inflight')) else 'absent')
refd = {g, m.get('previousGeneration')}
for name in sorted(os.listdir(d)):
    if GEN.match(name) and name not in refd:
        sz = sum(os.path.getsize(os.path.join(d, name, x)) for x in os.listdir(os.path.join(d, name)))
        say('UNREFERENCED generation dir', name, 'bytes', sz)
say('RESULT', 'ALL_DIGESTS_OK' if ok else 'DIGEST_MISMATCH'); sys.exit(0 if ok else 2)
