#!/usr/bin/env python3
"""
CoNET Kubo fragment ingest (投稿) — pin Beamio fragment payloads into local Kubo.

Security:
  - Shared token header: X-CoNET-IPFS-Token
  - Source IP allowlist (default: ipfs.conet.network host 38.102.126.30 + localhost)

Only meant to accept traffic from the CoNET IPFS fragment daemon.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

LISTEN_HOST = os.environ.get("CONET_KUBO_INGEST_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("CONET_KUBO_INGEST_PORT", "9545"))
IPFS_PATH = os.environ.get("IPFS_PATH", "/var/lib/ipfs")
IPFS_BIN = os.environ.get("IPFS_BIN", "/usr/local/bin/ipfs")
TOKEN_FILE = Path(os.environ.get("CONET_KUBO_INGEST_TOKEN_FILE", "/etc/conet-kubo-ingest/token"))
MAP_DIR = Path(os.environ.get("CONET_KUBO_INGEST_MAP_DIR", "/var/lib/ipfs/conet-fragment-map"))
TMP_DIR = Path(os.environ.get("CONET_KUBO_INGEST_TMP_DIR", "/var/lib/ipfs/tmp"))
MAX_BODY_BYTES = int(os.environ.get("CONET_KUBO_INGEST_MAX_BYTES", str(300 * 1024 * 1024)))
ALLOW_IPS = {
	x.strip()
	for x in os.environ.get(
		"CONET_KUBO_INGEST_ALLOW_IPS",
		"38.102.126.30,127.0.0.1,::1",
	).split(",")
	if x.strip()
}


def load_token() -> str:
	if not TOKEN_FILE.is_file():
		raise SystemExit(f"missing token file: {TOKEN_FILE}")
	return TOKEN_FILE.read_text(encoding="utf-8").strip()


TOKEN = load_token()
MAP_DIR.mkdir(parents=True, exist_ok=True)
TMP_DIR.mkdir(parents=True, exist_ok=True)


def client_ip(handler: BaseHTTPRequestHandler) -> str:
	host = handler.client_address[0]
	if host.startswith("::ffff:"):
		host = host[7:]
	return host


def run_ipfs(args: list[str]) -> subprocess.CompletedProcess[bytes]:
	env = os.environ.copy()
	env["IPFS_PATH"] = IPFS_PATH
	cmd = [IPFS_BIN, *args]
	return subprocess.run(cmd, env=env, capture_output=True, check=False)


def pin_payload(fragment_hash: str, data: str) -> dict:
	normalized = fragment_hash.strip().lower()
	if not normalized.startswith("0x") or len(normalized) != 66:
		raise ValueError("hash must be 0x + 64 hex")

	map_path = MAP_DIR / f"{normalized}.json"
	if map_path.is_file():
		existing = json.loads(map_path.read_text(encoding="utf-8"))
		cid = existing.get("cid")
		if cid:
			run_ipfs(["pin", "add", "--recursive=true", cid])
			run_ipfs(["routing", "provide", cid])
			return {"ok": True, "hash": normalized, "cid": cid, "deduped": True}

	raw = data.encode("utf-8")
	fd, tmp_path = tempfile.mkstemp(prefix="conet-frag-", dir=str(TMP_DIR))
	try:
		with os.fdopen(fd, "wb") as tmp:
			tmp.write(raw)
		add = run_ipfs(["add", "-Q", "--pin=true", "--", tmp_path])
		if add.returncode != 0:
			err = (add.stderr or add.stdout or b"").decode("utf-8", errors="replace")
			raise RuntimeError(f"ipfs add failed: {err}")
		cid = add.stdout.decode("utf-8").strip()
		if not cid:
			raise RuntimeError("ipfs add returned empty cid")
		run_ipfs(["routing", "provide", cid])
		payload = {
			"hash": normalized,
			"cid": cid,
			"bytes": len(raw),
			"sha256": hashlib.sha256(raw).hexdigest(),
		}
		map_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
		return {"ok": True, **payload, "deduped": False}
	finally:
		try:
			os.unlink(tmp_path)
		except OSError:
			pass


class Handler(BaseHTTPRequestHandler):
	server_version = "CoNET-Kubo-Ingest/1.0"

	def log_message(self, fmt: str, *args) -> None:
		print(f"[conet-kubo-ingest] {self.address_string()} {fmt % args}")

	def _send(self, code: int, obj: dict) -> None:
		body = json.dumps(obj).encode("utf-8")
		self.send_response(code)
		self.send_header("Content-Type", "application/json")
		self.send_header("Content-Length", str(len(body)))
		self.end_headers()
		self.wfile.write(body)

	def do_GET(self) -> None:
		path = urlparse(self.path).path
		if path in ("/health", "/api/health"):
			return self._send(200, {"ok": True, "service": "conet-kubo-ingest"})
		return self._send(404, {"ok": False, "error": "not found"})

	def do_POST(self) -> None:
		path = urlparse(self.path).path
		if path != "/api/pinFragment":
			return self._send(404, {"ok": False, "error": "not found"})

		ip = client_ip(self)
		if ip not in ALLOW_IPS:
			return self._send(403, {"ok": False, "error": f"source IP not allowed: {ip}"})

		token = self.headers.get("X-CoNET-IPFS-Token", "")
		if not token or token != TOKEN:
			return self._send(403, {"ok": False, "error": "invalid token"})

		length = int(self.headers.get("Content-Length") or "0")
		if length <= 0 or length > MAX_BODY_BYTES:
			return self._send(413, {"ok": False, "error": "body too large or empty"})

		raw = self.rfile.read(length)
		try:
			obj = json.loads(raw.decode("utf-8"))
		except Exception:
			return self._send(400, {"ok": False, "error": "invalid json"})

		fragment_hash = str(obj.get("hash") or "").strip()
		data = obj.get("data")
		if not fragment_hash or not isinstance(data, str) or data == "":
			return self._send(400, {"ok": False, "error": "hash and data required"})

		try:
			result = pin_payload(fragment_hash, data)
			return self._send(200, result)
		except ValueError as e:
			return self._send(400, {"ok": False, "error": str(e)})
		except Exception as e:
			return self._send(500, {"ok": False, "error": str(e)})


def main() -> None:
	server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
	print(
		f"[conet-kubo-ingest] listening on {LISTEN_HOST}:{LISTEN_PORT} "
		f"allow={sorted(ALLOW_IPS)} ipfs_path={IPFS_PATH}"
	)
	server.serve_forever()


if __name__ == "__main__":
	main()
