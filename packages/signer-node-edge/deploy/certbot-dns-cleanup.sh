#!/bin/sh
# Certbot DNS-01 cleanup hook. Deletes only the record id from CERTBOT_AUTH_OUTPUT.
# If that output is absent, it uses the state file named with the SHA-256 of
# CERTBOT_VALIDATION. It never lists records by name.
set -eu
python3 - << 'PY'
import hashlib, json, os, stat, urllib.error, urllib.parse, urllib.request

STAGING_NAME = "dle-dns01-staging.conet.network"
CHALLENGE_NAME = "_acme-challenge." + STAGING_NAME
FORBIDDEN = {"dle.conet.network", "_acme-challenge.dle.conet.network"}
ALLOWED_KEYS = {"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"}
LIVE_ORIGIN = "https://api.cloudflare.com/client/v4"
ENV_PATH = os.environ.get("SIGNER_EDGE_DNS01_ENV", "/var/lib/signer-edge-dns/cloudflare.env")
STATE_DIR = os.environ.get("SIGNER_EDGE_DNS01_STATE", "/var/lib/signer-edge-dns")

def fail(code):
    raise SystemExit(code)

def api_base():
    stub = os.environ.get("SIGNER_EDGE_DNS01_STUB") == "1"
    raw = os.environ.get("SIGNER_EDGE_DNS01_API_BASE", "").strip().rstrip("/")
    if stub:
        parsed = urllib.parse.urlparse(raw)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.path.rstrip("/") != "/client/v4":
            fail(2)
        return raw
    if raw and raw != LIVE_ORIGIN:
        fail(2)
    return LIVE_ORIGIN

def read_env():
    try:
        info = os.stat(ENV_PATH)
    except OSError:
        fail(2)
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        fail(2)
    values = {}
    with open(ENV_PATH, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                fail(2)
            key, value = line.split("=", 1)
            if key not in ALLOWED_KEYS or not value:
                fail(2)
            values[key] = value
    if set(values) != ALLOWED_KEYS:
        fail(2)
    return values

def parse_output(text):
    fields = {}
    for part in (text or "").split():
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        fields[key] = value
    return fields

def state_path(validation):
    digest = hashlib.sha256(validation.encode("utf-8")).hexdigest()
    return os.path.join(STATE_DIR, "challenge-" + digest + ".json")

domain = os.environ.get("CERTBOT_DOMAIN", "")
if domain in FORBIDDEN or domain != STAGING_NAME:
    fail(2)
base = api_base()
output = parse_output(os.environ.get("CERTBOT_AUTH_OUTPUT", ""))
if output.get("type", "TXT") != "TXT" or output.get("name", CHALLENGE_NAME) != CHALLENGE_NAME:
    fail(2)
validation = os.environ.get("CERTBOT_VALIDATION", "")
path = state_path(validation) if validation else ""
state = None
if path and os.path.exists(path):
    info = os.stat(path)
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        fail(2)
    with open(path, encoding="utf-8") as handle:
        state = json.load(handle)
    if state.get("type") != "TXT" or state.get("name") != CHALLENGE_NAME or not state.get("id"):
        fail(2)
output_id = output.get("id", "")
state_id = state.get("id") if isinstance(state, dict) else ""
if output_id and state_id and output_id != state_id:
    fail(2)
record_id = output_id or state_id
if not record_id:
    raise SystemExit(0)
if state is None and (output.get("type") != "TXT" or output.get("name") != CHALLENGE_NAME):
    fail(2)
values = read_env()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect)
request = urllib.request.Request(
    base + "/zones/" + values["CLOUDFLARE_ZONE_ID"] + "/dns_records/" + record_id,
    method="DELETE",
    headers={"Authorization": "Bearer " + values["CLOUDFLARE_API_TOKEN"]},
)
try:
    with opener.open(request, timeout=15) as response:
        payload = json.load(response)
except (OSError, urllib.error.URLError, json.JSONDecodeError):
    fail(1)
if not isinstance(payload, dict) or not payload.get("success"):
    fail(1)
if path and os.path.exists(path):
    os.remove(path)
PY
