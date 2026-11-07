#!/usr/bin/env python3
"""A small App Store Connect API client for publishing tuichess 3D.

Credentials come from Perry's config (~/.perry/config.toml, [apple]: key_id, issuer_id,
p8_key_path), the same API key `perry publish` uses.

    python3 web3d/bloom/store/asc.py GET  /v1/apps 'filter[bundleId]=com.skelpo.tuichess'
    python3 web3d/bloom/store/asc.py POST /v1/bundleIds '{"data": {...}}'

As a module: `from asc import api` -> api("GET", "/v1/apps", params={...}).
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import jwt

BASE = "https://api.appstoreconnect.apple.com"


def _config():
    path = os.path.expanduser("~/.perry/config.toml")
    text = open(path).read()
    section = text.split("[apple]", 1)[1].split("\n[", 1)[0]
    get = lambda k: re.search(rf'^{k}\s*=\s*"([^"]*)"', section, re.M).group(1)
    return get("key_id"), get("issuer_id"), os.path.expanduser(get("p8_key_path"))


_token = None
_token_exp = 0


def token():
    global _token, _token_exp
    if _token is None or time.time() > _token_exp - 60:
        key_id, issuer, key_path = _config()
        now = int(time.time())
        _token_exp = now + 1100
        _token = jwt.encode({"iss": issuer, "iat": now, "exp": _token_exp, "aud": "appstoreconnect-v1"},
                            open(key_path).read(), algorithm="ES256", headers={"kid": key_id, "typ": "JWT"})
    return _token


def api(method, path, body=None, params=None, raw=False):
    """Call the API; returns the decoded JSON (or None for 204). Raises RuntimeError with Apple's errors."""
    url = path if path.startswith("http") else BASE + path
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, safe="[],")
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": "Bearer " + token()})
    if body is not None and not isinstance(body, bytes):
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            out = r.read()
            if raw:
                return out
            return json.loads(out) if out else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail[:2000]}") from None


def all_pages(path, params=None):
    """Every item of a paged GET."""
    out, page = [], api("GET", path, params=params)
    while True:
        out += page.get("data", [])
        nxt = page.get("links", {}).get("next")
        if not nxt:
            return out
        page = api("GET", nxt)


if __name__ == "__main__":
    method, path = sys.argv[1], sys.argv[2]
    arg = sys.argv[3] if len(sys.argv) > 3 else None
    if method == "GET":
        params = dict(urllib.parse.parse_qsl(arg)) if arg else None
        print(json.dumps(api("GET", path, params=params), indent=1))
    else:
        print(json.dumps(api(method, path, body=json.loads(arg) if arg else None), indent=1))
