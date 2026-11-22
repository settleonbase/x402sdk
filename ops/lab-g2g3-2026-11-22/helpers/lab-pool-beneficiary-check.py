#!/usr/bin/env python3
# Read-only check of the Lab CL payout beneficiary on CoNET L1 (chainId 224422).
# Usage: python3 -I lab-pool-beneficiary-check.py --rpc <URL> [--tx <0x hash>]
# Exit 0 = every check passed; non-zero = at least one FAIL/UNKNOWN. Sends only eth_* read calls. Never signs or broadcasts.
import sys, json, hashlib, urllib.request

CHAIN = 0x36ca6
POOL = "0x32bE583C8e778FFfC5107BF34820c2B225336201".lower()          # ConetLabMiningPool proxy (the only allowed beneficiary)
POOL_IMPL = "0x98962C9a8eB80F20a194057686AC151018031166".lower()     # ConetLabMiningPool implementation (EIP-1967 slot)
VDR = "0xc71e246DD78B37C2fABc905D340932F28F503433".lower()           # ValidatorDepositRedeem proxy (withdrawNative caller target)
VDR_IMPL = "0x6eea3683b603B66E79e02FaBfaCE166ec596fFc3".lower()
LAB = "0xcFAF85E6C1765DA01a4Dc58C81b28Cd572067135".lower()           # Lab dedicated signer wallet (sender of withdrawNative)
PROXY_CODE_SHA256 = "f6e16d138972352c3119caabb2d92144a810cb30d3a031830024a3855b6d0044"
PROXY_CODE_BYTES = 163
SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
SEL_WITHDRAW_NATIVE = "0x07b18bde"  # withdrawNative(address,uint256)

def make_rpc(url):
    n = [0]
    def call(method, params):
        n[0] += 1
        body = json.dumps({"jsonrpc": "2.0", "id": n[0], "method": method, "params": params}).encode()
        req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            out = json.load(r)
        if "error" in out:
            raise RuntimeError(f"{method}: {out['error']}")
        return out["result"]
    return call

def code_info(rpc, addr):
    code = rpc("eth_getCode", [addr, "latest"])
    raw = bytes.fromhex(code[2:]) if isinstance(code, str) and len(code) > 2 else b""
    return len(raw), hashlib.sha256(raw).hexdigest() if raw else ""

def addr_of_word(w):
    return "0x" + w[-40:].lower()

def run(rpc, tx=None):
    res = []  # (name, ok)
    def rec(name, ok, detail=""):
        res.append((name, ok)); print(("PASS " if ok else "FAIL ") + name + (" " + detail if detail else ""))
    try:
        rec("chainId==224422", int(rpc("eth_chainId", []), 16) == CHAIN)
        for label, a, impl in (("pool", POOL, POOL_IMPL), ("vdr", VDR, VDR_IMPL)):
            n, h = code_info(rpc, a)
            rec(f"{label} proxy code {PROXY_CODE_BYTES} bytes sha256 match", n == PROXY_CODE_BYTES and h == PROXY_CODE_SHA256, f"{n}B {h[:16]}")
            slot = rpc("eth_getStorageAt", [a, SLOT_IMPL, "latest"])
            rec(f"{label} EIP-1967 implementation == expected", addr_of_word(slot) == impl, addr_of_word(slot))
            n2, _ = code_info(rpc, impl)
            rec(f"{label} implementation has code", n2 > 0, f"{n2}B")
        if tx:
            t = rpc("eth_getTransactionByHash", [tx])
            r = rpc("eth_getTransactionReceipt", [tx])
            if not t or not r:
                rec("tx and receipt readable", False, "UNKNOWN (read failed or not found)")
            else:
                inp = t["input"].lower()
                rec("tx.from == Lab wallet", t["from"].lower() == LAB, t["from"])
                rec("tx.to == VDR proxy", (t.get("to") or "").lower() == VDR, str(t.get("to")))
                rec("tx.value == 0", int(t["value"], 16) == 0)
                rec("calldata is exactly withdrawNative(address,uint256) with 2 words", inp[:10] == SEL_WITHDRAW_NATIVE and len(inp) == 10 + 128, inp[:10] + f" len={len(inp)}")
                if len(inp) == 10 + 128:
                    w0, w1 = inp[10:74], inp[74:138]
                    rec("calldata word0 high 12 bytes are zero", w0[:24] == "0" * 24)
                    rec("calldata arg0 (beneficiary) == ConetLabMiningPool", addr_of_word(w0) == POOL, addr_of_word(w0))
                    amount = int(w1, 16)
                    ok_status = r.get("status") == "0x1"
                    rec("receipt.status == 1", ok_status, str(r.get("status")))
                    bn = int(r["blockNumber"], 16)
                    b0 = int(rpc("eth_getBalance", [POOL, hex(bn - 1)]), 16)
                    b1 = int(rpc("eth_getBalance", [POOL, hex(bn)]), 16)
                    delta = b1 - b0
                    # delta >= amount is required evidence; a smaller delta is NOT proof and is reported as not-confirmed
                    rec("pool balance delta between block-1 and block >= amount", delta >= amount, f"amount={amount} delta={delta} block={bn}")
    except Exception as e:  # any read failure is unknown, never a pass
        rec("rpc reads complete", False, f"UNKNOWN: {e}")
    ok = bool(res) and all(o for _, o in res)
    print("RESULT " + ("ALL_PASS" if ok else "NOT_PASSED"))
    return 0 if ok else 1

if __name__ == "__main__":
    a = sys.argv[1:]
    if "--rpc" not in a:
        print("usage: --rpc URL [--tx HASH]"); sys.exit(2)
    url = a[a.index("--rpc") + 1]
    tx = a[a.index("--tx") + 1] if "--tx" in a else None
    sys.exit(run(make_rpc(url), tx))
