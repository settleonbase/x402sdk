#!/usr/bin/env python3
"""Lab daemon running gate (read-only). Run as the operator account every 5 minutes while the Lab unit runs (and once before every start).
usage: lab-gatecheck.py --mem-floor-kb <KiB> --signer-restarts <N> --claim-restarts <N> [--meminfo <file>]
STOP (exit 3, last line LABRUN_STOP) when: MemAvailable < floor; the signer unit's NRestarts != the recorded baseline; the Claim unit's NRestarts != the
recorded baseline; any of these cannot be read (UNKNOWN is a stop). Exit 0 and last line LABRUN_OK otherwise. The action on STOP is the approved stop of the
LAB unit only (never the signer, Claim or Oracle): see d6 section 4. Prints numbers only."""
import os, subprocess, sys

SIGNER = os.environ['LAB_SIGNER_UNIT']  # site values from the environment (nothing about the host is written in this file)
CLAIM = os.environ['LAB_CLAIM_UNIT']
SYSTEMCTL = os.environ.get('LAB_GATE_SYSTEMCTL', '/usr/bin/systemctl')

def nrestarts(unit):
    try:
        r = subprocess.run([SYSTEMCTL, 'show', unit, '-p', 'NRestarts', '--value', '--no-pager'], capture_output=True, text=True)
    except OSError:
        return None
    if r.returncode != 0 or not r.stdout.strip().isdigit():
        return None
    return int(r.stdout.strip())

def main(a):
    def arg(k):
        return a[a.index(k) + 1] if k in a else None
    try:
        floor, sb, cb = int(arg('--mem-floor-kb')), int(arg('--signer-restarts')), int(arg('--claim-restarts'))
    except Exception:
        print('usage: --mem-floor-kb N --signer-restarts N --claim-restarts N'); return 2
    stop = []
    try:
        mem = None
        for ln in open(arg('--meminfo') or '/proc/meminfo'):
            if ln.startswith('MemAvailable:'):
                mem = int(ln.split()[1])
    except Exception:
        mem = None
    print('mem_available_kb', mem)
    if mem is None or mem < floor: stop.append('memory')
    s, c = nrestarts(SIGNER), nrestarts(CLAIM)
    print('signer_nrestarts', s, 'baseline', sb); print('claim_nrestarts', c, 'baseline', cb)
    if s is None or s != sb: stop.append('signer-restarts')
    if c is None or c != cb: stop.append('claim-restarts')
    if stop:
        print('stop_reasons', ','.join(stop)); print('LABRUN_STOP'); return 3
    print('LABRUN_OK'); return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
