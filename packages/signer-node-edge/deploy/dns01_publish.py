#!/usr/bin/env python3
"""Refuse an atomic certificate switch unless the current profile matches."""

import os
import subprocess
import tempfile
from datetime import datetime, timezone

from dns01_profile import selected_profile

def refuse(reason):
    raise SystemExit("publish-refused reason=" + reason)


def openssl(args, input_bytes=None):
    return subprocess.run(args, input=input_bytes, capture_output=True, text=input_bytes is None)


def openssl_text(args):
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        refuse("openssl")
    return proc.stdout


def split_certs(blob):
    marker = b"-----END CERTIFICATE-----"
    parts = []
    start = 0
    while True:
        end = blob.find(marker, start)
        if end < 0:
            break
        parts.append(blob[start:end + len(marker)] + b"\n")
        start = end + len(marker)
    if not parts:
        refuse("chain")
    return parts[0], b"".join(parts[1:])


def common_name(subject):
    for part in subject.replace("subject=", "").split(","):
        item = part.strip()
        if item.startswith("CN =") or item.startswith("CN="):
            return item.split("=", 1)[1].strip()
    return ""


def san_names(text):
    names = []
    for line in text.splitlines():
        if "DNS:" not in line:
            continue
        for piece in line.split(","):
            piece = piece.strip()
            if piece.startswith("DNS:"):
                names.append(piece[4:].strip())
    return names


def parse_time(prefix, blob):
    for line in blob.splitlines():
        if line.startswith(prefix):
            return datetime.strptime(line.split("=", 1)[1].strip(), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    refuse("dates")


def pubkey_der(args):
    proc = subprocess.run(args, capture_output=True)
    if proc.returncode != 0:
        refuse("key")
    der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "DER"], input=proc.stdout, capture_output=True)
    if der.returncode != 0 or not der.stdout:
        refuse("key")
    return der.stdout


def main():
    profile, spec = selected_profile()
    cert_path = os.environ.get("SIGNER_EDGE_PUBLISH_CERT", "")
    key_path = os.environ.get("SIGNER_EDGE_PUBLISH_KEY", "")
    if not cert_path or not key_path:
        refuse("paths")
    subject = openssl_text(["openssl", "x509", "-in", cert_path, "-noout", "-subject"])
    if common_name(subject) != spec["cert_name"]:
        refuse("name")
    san = subprocess.run(["openssl", "x509", "-in", cert_path, "-noout", "-ext", "subjectAltName"], capture_output=True, text=True)
    names = san_names(san.stdout or "")
    if names and names != [spec["cert_name"]]:
        refuse("name")
    issuer = openssl_text(["openssl", "x509", "-in", cert_path, "-noout", "-issuer"])
    if profile == "production" and "(STAGING)" in issuer:
        refuse("staging-issuer")
    dates = openssl_text(["openssl", "x509", "-in", cert_path, "-noout", "-startdate", "-enddate"])
    begin = parse_time("notBefore=", dates)
    end = parse_time("notAfter=", dates)
    now = datetime.now(timezone.utc)
    if not (begin <= now <= end):
        refuse("dates")
    blob = open(cert_path, "rb").read()
    leaf, chain = split_certs(blob)
    ca = os.environ.get("SIGNER_EDGE_DEPLOY_CA", "/etc/ssl/certs/ca-certificates.crt")
    with tempfile.TemporaryDirectory() as tmp:
        leaf_path = os.path.join(tmp, "leaf.pem")
        chain_path = os.path.join(tmp, "chain.pem")
        open(leaf_path, "wb").write(leaf)
        open(chain_path, "wb").write(chain)
        cmd = ["openssl", "verify", "-CAfile", ca]
        if chain.strip():
            cmd.extend(["-untrusted", chain_path])
        cmd.append(leaf_path)
        verified = subprocess.run(cmd, capture_output=True, text=True)
        if verified.returncode != 0 or not verified.stdout.strip().endswith(": OK"):
            refuse("chain")
    leaf_pub = pubkey_der(["openssl", "x509", "-in", cert_path, "-pubkey", "-noout"])
    key_pub = pubkey_der(["openssl", "pkey", "-in", key_path, "-pubout"])
    if leaf_pub != key_pub:
        refuse("key")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        if isinstance(exc.code, str):
            import sys
            sys.stderr.write(exc.code + "\n")
            raise SystemExit(1)
        raise
