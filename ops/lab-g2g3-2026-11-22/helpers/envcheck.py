#!/usr/bin/env python3
"""Lab payout daemon environment-file check (v3 r10 section 4.3). READ-ONLY; run as root (the env file is private). Prints key NAMES, PASS/FAIL and, for the three
endpoint keys, the HOST NAME only. It never prints any other value.
usage: lab-envcheck.py --env <env file> [--env <later env file> ...] --phase pre|first|run --deny <deny file> --pubkeys-sha <sha256 of the repo pubkeys file expected>
  pre    before the first start: master switch must be 0
  first  at the first start: master switch 1 and MAX_SETTLED_BATCHES == 1
  run    continuous running: master switch 1 and MAX_SETTLED_BATCHES unset
The env files are applied in order (a later file overrides an earlier one, exactly like systemd EnvironmentFile= lines).
Exit 0 and last line ENVCHECK_OK = every check passed; FAIL/UNKNOWN = stop."""
import hashlib, json, os, re, sys, urllib.parse

P = 'CONET_LAB_MINING_POOL_CL_PAYOUT'
LAB = '0xcfaf85e6c1765da01a4dc58c81b28cd572067135'
POOL = '0x32be583c8e778fffc5107bf34820c2b225336201'
VDR = '0xc71e246dd78b37c2fabc905d340932f28f503433'
STATE = os.environ['LAB_STATE_FILE']  # site value from the environment (nothing about the host is written in this file)
out = []
def rec(name, ok, detail=''):
    out.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + detail if detail else ''))

def parse(path):
    d = {}
    for ln in open(path, encoding='utf-8', errors='replace'):
        ln = ln.strip()
        if not ln or ln.startswith('#') or '=' not in ln:
            continue
        k, v = ln.split('=', 1); k = k.strip()
        if k.startswith('export '): k = k[7:].strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'': v = v[1:-1]
        d[k] = v
    return d

def host(u):
    return urllib.parse.urlparse(u).netloc

def main(a):
    def arg(k):
        return a[a.index(k) + 1] if k in a else None
    envs = [a[i + 1] for i, x in enumerate(a) if x == '--env' and i + 1 < len(a)]
    phase, denyp, pksha = arg('--phase'), arg('--deny'), arg('--pubkeys-sha')
    if not (envs and denyp and pksha) or phase not in ('pre', 'first', 'run'):
        print('usage: --env <file> --phase pre|first|run --deny <file> --pubkeys-sha <sha>'); return 2
    try:
        e = {}
        for p in envs:
            e.update(parse(p))
        deny = json.load(open(denyp))
    except Exception as ex:
        print('FAIL files readable UNKNOWN', type(ex).__name__); print('ENVCHECK_FAIL'); return 1
    sw = e.get(P)
    rec('master switch ' + P, (sw == '0') if phase == 'pre' else (sw == '1'), 'phase=' + phase)
    for k in (P + '_DRY_RUN', 'CONET_VALIDATOR_DRY_RUN'):
        rec(k + ' unset or 0', e.get(k) in (None, '', '0'))
    sock, arr = e.get(P + '_SIGNER_SOCKET'), e.get(P + '_KEY_ARRAY')
    rec(P + '_SIGNER_SOCKET set and not a deny-listed socket', bool(sock) and sock not in deny.get('sockets', []))
    rec(P + '_KEY_ARRAY == lab_mining_pool_payout and not deny-listed', arr == 'lab_mining_pool_payout' and arr not in deny.get('keyArrays', []))
    rec(P + '_SIGNER_ADDRESS == the Lab wallet', (e.get(P + '_SIGNER_ADDRESS') or '').lower() == LAB)
    dl = e.get('CONET_LAB_DENY_LIST_FILE')
    rec('CONET_LAB_DENY_LIST_FILE set and equals the verified deny file path', bool(dl) and os.path.realpath(dl) == os.path.realpath(denyp))
    rec('CONET_LAB_MINING_POOL_ALLOW_LEGACY_PAYOUT is not 1', e.get('CONET_LAB_MINING_POOL_ALLOW_LEGACY_PAYOUT', '') != '1')
    rec(P + '_STATE_FILE is the legacy ledger path', e.get(P + '_STATE_FILE') == STATE)
    pk = e.get('CONET_LAB_MINING_POOL_PUBKEYS_FILE')
    try:
        okpk = bool(pk) and hashlib.sha256(open(pk, 'rb').read()).hexdigest() == pksha
    except Exception:
        okpk = False
    rec('CONET_LAB_MINING_POOL_PUBKEYS_FILE content sha256 == expected', okpk)
    pa = e.get('CONET_LAB_MINING_POOL_ADDRESS')
    rec('CONET_LAB_MINING_POOL_ADDRESS unset or the fixed pool', pa in (None, '') or pa.lower() == POOL)
    rec('CONET_VALIDATOR_DEPOSIT_REDEEM unset or the pinned VDR', e.get('CONET_VALIDATOR_DEPOSIT_REDEEM') in (None, '') or e['CONET_VALIDATOR_DEPOSIT_REDEEM'].lower() == VDR)
    rec(P + '_CONSUMED_KEYS_MAX == 3000000 (explicit; the code silently falls back to 200000 on any other value)', e.get(P + '_CONSUMED_KEYS_MAX') == '3000000')
    rec(P + '_DEPLOY_BLOCK == 2009200', e.get(P + '_DEPLOY_BLOCK') == '2009200')
    rec('gas: MAX_GAS_PRICE_GWEI == 0.03, GAS_WAIT_FORCE_MS == 300000, GAS_LIMIT == 800000, all explicit', e.get(P + '_MAX_GAS_PRICE_GWEI') == '0.03' and e.get(P + '_GAS_WAIT_FORCE_MS') == '300000' and e.get(P + '_GAS_LIMIT') == '800000')
    rec('gas: ' + P + '_MAX_GAS_PRICE_WEI is not set (it would override the Gwei value)', P + '_MAX_GAS_PRICE_WEI' not in e)
    ms = e.get(P + '_MAX_SETTLED_BATCHES')
    rec(P + '_MAX_SETTLED_BATCHES ' + ('== 1' if phase == 'first' else ('unset' if phase == 'run' else 'unset or 1')), (ms == '1') if phase == 'first' else ((ms in (None, '')) if phase == 'run' else (ms in (None, '', '1'))))
    for k in ('CONET_RPC_URL', 'CONET_VALIDATOR_DEPOSIT_RPC_URL', 'CONET_VALIDATOR_BEACON_REST_URL'):
        v = e.get(k)
        rec(k + ' is an http(s) URL (host printed)', bool(v) and v.startswith(('http://', 'https://')), host(v) if v else '')
    good = bool(out) and all(out)
    print('ENVCHECK_OK' if good else 'ENVCHECK_FAIL'); return 0 if good else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
