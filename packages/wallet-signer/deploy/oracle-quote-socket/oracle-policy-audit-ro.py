#!/usr/bin/python3 -I
"""Read-only: can the running signer policy let oracle-daemon send updateRatesBatch on the oracle contract, and what does
the signer audit say about that client? Prints policy/limit values (public parameters) and audit event summaries only:
no keys, no calldata, no token hashes, no address lists. Writes nothing.

Usage: oracle-policy-audit-ro.py --config RUNNING_CONFIG_JSON
  The policy file and the audit directory are taken from the running config itself (policyFile, logDir), so what is
  checked is exactly what the running signer loads. Run via sudo (the files are not world readable).

Exit codes: 0 = allow rule found (limits printed for the reader to judge); 3 = STOP (no usable allow rule, client
disabled, chain not granted, or unreadable policy/config); 2 = usage error. A missing audit record never changes the exit code."""
import json, os, sys

CLIENT = 'oracle-daemon'
ARRAY = 'beamio_oracle_owner'
TO = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008'.lower()
SEL = 'updateRatesBatch('
CHAIN = 224422

def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)

def main(argv):
    if len(argv) != 3 or argv[1] != '--config':
        print('usage: oracle-policy-audit-ro.py --config RUNNING_CONFIG_JSON', file=sys.stderr); return 2
    try:
        cfg = load(argv[2])
        policy_path = cfg['policyFile']; log_dir = cfg['logDir']
    except Exception as e:
        print('CONFIG_READ_ERROR %s: %s' % (type(e).__name__, e)); return 3
    audit_path = os.path.join(log_dir, 'audit.jsonl')
    print('config %s' % argv[2]); print('policyFile %s' % policy_path); print('logDir %s' % log_dir)
    stop = []
    try:
        pol = load(policy_path)
        cp = pol['clients'][CLIENT]
        arr = cp['arrays'][ARRAY]
    except Exception as e:
        print('POLICY_READ_ERROR %s: %s' % (type(e).__name__, e)); return 3
    disabled = cp.get('disabled')
    print('client %s disabled %s' % (CLIENT, disabled))
    if disabled:
        stop.append('client disabled')
    chains = arr.get('chains')
    print('array %s chains %s' % (ARRAY, chains))
    if not isinstance(chains, list) or CHAIN not in chains:
        stop.append('chain %d not granted' % CHAIN)
    ck = str(CHAIN)
    mg = (arr.get('maxGasPriceGwei') or {})
    db = (arr.get('dailyGasBudgetWei') or {})
    print('LIMIT maxGasPriceGwei[%s] %s' % (ck, mg[ck] if ck in mg else 'no key for this chain'))
    print('LIMIT dailyGasBudgetWei[%s] %s' % (ck, db[ck] if ck in db else 'no key for this chain'))
    print('LIMIT rate %s' % (arr.get('rate') if arr.get('rate') is not None else 'none'))
    print('LIMIT maxInflightPerKey %s' % (arr.get('maxInflightPerKey') if 'maxInflightPerKey' in arr else 'unset (policy default)'))
    found = False
    for i, rule in enumerate(arr.get('allow', [])):
        to = str(rule.get('to', ''))
        sels = [s for s in rule.get('selectors', []) if isinstance(s, str)]
        hit = to.lower() == TO and any(s.startswith(SEL) for s in sels)
        found = found or hit
        # arg constraints: indexes and rule kinds only (eq/in list values are never printed; min/max are numbers)
        args = {}
        for idx, ar in (rule.get('args') or {}).items():
            kinds = {}
            for k, v in (ar or {}).items():
                kinds[k] = v if k in ('minItems', 'maxItems') else ('list' if isinstance(v, list) else 'value')
            args[idx] = kinds
        print('allow[%d] to %s selectors %s maxGas %s maxValueWei %s args %s equalArrays %s %s' % (
            i, to, [s.split('(')[0] for s in sels], rule.get('maxGas'), rule.get('maxValueWei'),
            args if args else 'none', rule.get('equalArrays', 'none'), 'MATCH' if hit else ''))
    if not found:
        stop.append('no allow rule for %s %s on oracle contract' % (ARRAY, SEL[:-1]))
    last_sent = None; last_deny = None; n_sent = 0; n_deny = 0; bad = 0
    try:
        with open(audit_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                if CLIENT not in line or ('"tx.sent"' not in line and '"deny"' not in line):
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    bad += 1; continue
                if o.get('client') != CLIENT:
                    continue
                if o.get('event') == 'tx.sent':
                    n_sent += 1; last_sent = o
                elif o.get('event') == 'deny':
                    n_deny += 1; last_deny = o
    except Exception as e:
        print('AUDIT_READ_ERROR %s: %s' % (type(e).__name__, e))
    if last_sent:
        print('AUDIT_LAST_SENT ts %s method %s array %s chainId %s to %s (count %d)' % (
            last_sent.get('ts'), last_sent.get('method'), last_sent.get('array'), last_sent.get('chainId'), last_sent.get('to'), n_sent))
    else:
        print('AUDIT_LAST_SENT none (count 0): record only, not blocking')
    if last_deny:
        print('AUDIT_LAST_DENY ts %s array %s chainId %s to %s selector %s reason %s (count %d)' % (
            last_deny.get('ts'), last_deny.get('array'), last_deny.get('chainId'), last_deny.get('to'),
            last_deny.get('selector'), str(last_deny.get('reason'))[:160], n_deny))
    else:
        print('AUDIT_LAST_DENY none (count 0)')
    print('audit unparsable lines %d' % bad)
    print('POLICY_VERDICT %s' % ('ALLOW' if not stop else 'STOP: ' + '; '.join(stop)))
    return 0 if not stop else 3

sys.exit(main(sys.argv))
