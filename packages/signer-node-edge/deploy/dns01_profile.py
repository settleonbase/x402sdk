"""DNS-01 profile selection. The default is staging."""

import os
import urllib.parse

LIVE_ORIGIN = "https://api.cloudflare.com/client/v4"
NAMESERVERS = ("matt.ns.cloudflare.com", "pola.ns.cloudflare.com")
PROFILES = {
    "staging": {
        "cert_name": "dle-dns01-staging.conet.network",
        "directory": "https://acme-staging-v02.api.letsencrypt.org/directory",
    },
    "production": {
        "cert_name": "dle.conet.network",
        "directory": "https://acme-v02.api.letsencrypt.org/directory",
    },
}


def fail(code):
    raise SystemExit(code)


def challenge_name(cert_name):
    return "_acme-challenge." + cert_name


def selected_profile():
    name = os.environ.get("SIGNER_EDGE_DNS01_PROFILE", "staging").strip() or "staging"
    spec = PROFILES.get(name)
    if spec is None:
        fail(2)
    return name, spec


def assert_profile_domain(domain):
    profile, spec = selected_profile()
    wanted = spec["cert_name"]
    forbidden = set()
    for other_name, other in PROFILES.items():
        if other_name == profile:
            continue
        forbidden.add(other["cert_name"])
        forbidden.add(challenge_name(other["cert_name"]))
    if domain in forbidden or domain != wanted:
        fail(2)
    directory = os.environ.get("SIGNER_EDGE_DNS01_DIRECTORY", "").strip().rstrip("/")
    if profile == "production" and not directory:
        fail(2)
    if directory and directory != spec["directory"]:
        fail(2)
    return profile, spec, challenge_name(wanted)


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
