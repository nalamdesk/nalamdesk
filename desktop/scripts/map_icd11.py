#!/usr/bin/env python3
"""Map catalog conditions to ICD-11 MMS codes via the WHO ICD-API.

One-time pull per ICD release; output is reviewed and pasted into the
SEED_CONDITIONS table in desktop/src/main/schema/migrations.ts (codes +
URIs + citation, per CC BY-ND 3.0 IGO).

Needs (env, never committed):
    WHO_ICD_CLIENT_ID / WHO_ICD_CLIENT_SECRET -- free OAuth credentials
    from https://icd.who.int/icdapi (registration, no fee).

Usage:
    python3 desktop/scripts/map_icd11.py conditions.txt > icd11_map.json
    # conditions.txt: one condition name per line

Suggested WHO citation for vendored codes:
    International Classification of Diseases Eleventh Revision (ICD-11).
    Geneva: World Health Organization; 2022.
    License: CC BY-ND 3.0 IGO.
"""
import json
import os
import subprocess
import sys
import urllib.parse

RELEASE = "2025-01"
TOKEN_URL = "https://icdaccessmanagement.who.int/connect/token"
API = "https://id.who.int"


def token(client_id: str, secret: str) -> str:
    raw = subprocess.run(
        ["curl", "-s", "-X", "POST", TOKEN_URL,
         "-H", "Content-Type: application/x-www-form-urlencoded",
         "-d", f"grant_type=client_credentials&client_id={client_id}&client_secret={secret}"],
        capture_output=True, text=True).stdout
    access = json.loads(raw).get("access_token")
    if not access:
        raise SystemExit(f"token request failed: {raw[:200]}")
    return access


def api_get(bearer: str, path: str) -> dict:
    raw = subprocess.run(
        ["curl", "-s", f"{API}{path}",
         "-H", f"Authorization: Bearer {bearer}",
         "-H", "Accept: application/json",
         "-H", "API-Version: v2",
         "-H", "Accept-Language: en"],
        capture_output=True, text=True).stdout
    return json.loads(raw)


def main(conditions_path: str) -> None:
    client_id = os.environ.get("WHO_ICD_CLIENT_ID")
    secret = os.environ.get("WHO_ICD_CLIENT_SECRET")
    if not client_id or not secret:
        raise SystemExit("set WHO_ICD_CLIENT_ID and WHO_ICD_CLIENT_SECRET in the environment")
    bearer = token(client_id, secret)
    names = [line.strip() for line in open(conditions_path) if line.strip()]
    result = {}
    for name in names:
        found = api_get(bearer, f"/icd/release/11/{RELEASE}/mms/search"
                                f"?q={urllib.parse.quote(name)}&flatResults=true")
        cands = [{"uri": e.get("id"), "title": e.get("title"), "score": e.get("score")}
                 for e in found.get("destinationEntities", [])[:3]]
        result[name] = cands
    json.dump(result, sys.stdout, indent=1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: map_icd11.py conditions.txt", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
