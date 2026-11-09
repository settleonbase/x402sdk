#!/bin/sh
# Certbot DNS-01 auth hook.
# Live calls use only https://api.cloudflare.com/client/v4. A loopback override
# is accepted only when SIGNER_EDGE_DNS01_STUB=1, and a bad origin exits before
# the bearer token is read or sent.
# The credential file is /var/lib/signer-edge-dns/cloudflare.env, mode 600 root:root.
# Allowed names: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID. Never pass the token on argv.
# Zone DNS Edit covers the whole zone. Keep the file on the ops host, not on dle.
# Stdout on success is the record id line Certbot stores as CERTBOT_AUTH_OUTPUT.
# A fallback state file is named with the SHA-256 of CERTBOT_VALIDATION.
set -eu
python3 - << 'PY'
import hashlib, json, os, stat, subprocess, time, urllib.error, urllib.parse, urllib.request

STAGING_NAME = "dle-dns01-staging.conet.network"
CHALLENGE_NAME = "_acme-challenge." + STAGING_NAME
FORBIDDEN = {"dle.conet.network", "_acme-challenge.dle.conet.network"}
ALLOWED_KEYS = {"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"}
LIVE_ORIGIN = "https://api.cloudflare.com/client/v4"
NAMESERVERS = ("matt.ns.cloudflare.com", "pola.ns.cloudflare.com")
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

def state_path(validation):
    digest = hashlib.sha256(validation.encode("utf-8")).hexdigest()
    return os.path.join(STATE_DIR, "challenge-" + digest + ".json")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def request_json(opener, url, method, token, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Authorization": "Bearer " + token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with opener.open(request, timeout=15) as response:
        return json.load(response)

def delete_id(opener, base, zone_id, token, record_id):
    payload = request_json(opener, base + "/zones/" + zone_id + "/dns_records/" + record_id, "DELETE", token)
    if not isinstance(payload, dict) or not payload.get("success"):
        fail(1)

def both_nameservers_see(validation):
    if os.environ.get("SIGNER_EDGE_DNS01_STUB") == "1":
        ns_dir = os.environ.get("SIGNER_EDGE_DNS01_NS_DIR", "")
        if not ns_dir:
            return False
        for ns in NAMESERVERS:
            try:
                with open(os.path.join(ns_dir, ns), encoding="utf-8") as handle:
                    seen = {line.strip() for line in handle if line.strip()}
            except OSError:
                return False
            if validation not in seen:
                return False
        return True
    for ns in NAMESERVERS:
        try:
            proc = subprocess.run(
                ["dig", "+time=2", "+tries=1", "+short", "TXT", "@" + ns, CHALLENGE_NAME],
                check=False, capture_output=True, text=True, timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        answers = (proc.stdout or "").replace('"', "")
        if validation not in answers:
            return False
    return True

domain = os.environ.get("CERTBOT_DOMAIN", "")
if domain in FORBIDDEN or domain != STAGING_NAME:
    fail(2)
validation = os.environ.get("CERTBOT_VALIDATION", "")
if not validation:
    fail(2)
base = api_base()
values = read_env()
opener = urllib.request.build_opener(NoRedirect)
try:
    payload = request_json(opener, base + "/zones/" + values["CLOUDFLARE_ZONE_ID"] + "/dns_records", "POST", values["CLOUDFLARE_API_TOKEN"], {
        "type": "TXT",
        "name": CHALLENGE_NAME,
        "content": validation,
        "ttl": 60,
    })
except (OSError, urllib.error.URLError, json.JSONDecodeError):
    fail(1)
result = payload.get("result") if isinstance(payload, dict) else None
record_id = result.get("id") if isinstance(result, dict) else ""
record_type = result.get("type") if isinstance(result, dict) else ""
record_name = result.get("name") if isinstance(result, dict) else ""
if not payload.get("success") or not record_id or record_type != "TXT" or record_name != CHALLENGE_NAME:
    if record_id:
        try:
            delete_id(opener, base, values["CLOUDFLARE_ZONE_ID"], values["CLOUDFLARE_API_TOKEN"], record_id)
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            pass
    fail(1)
os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
path = state_path(validation)
blob = json.dumps({"id": record_id, "type": "TXT", "name": CHALLENGE_NAME}).encode("utf-8")
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
try:
    os.write(fd, blob)
finally:
    os.close(fd)
tries = int(os.environ.get("SIGNER_EDGE_DNS01_NS_TRIES", "10"))
wait = float(os.environ.get("SIGNER_EDGE_DNS01_NS_WAIT", "3"))
seen = False
for attempt in range(max(tries, 1)):
    if both_nameservers_see(validation):
        seen = True
        break
    if attempt + 1 < tries and wait > 0:
        time.sleep(wait)
if not seen:
    try:
        delete_id(opener, base, values["CLOUDFLARE_ZONE_ID"], values["CLOUDFLARE_API_TOKEN"], record_id)
        os.remove(path)
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        fail(1)
    fail(1)
print("id=" + record_id + " type=TXT name=" + CHALLENGE_NAME)
PY
