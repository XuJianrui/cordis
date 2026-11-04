#!/usr/bin/env python3
"""Download GitHub Actions job logs for a list of runs.

Why this is not a one-liner: /actions/jobs/{id}/logs answers 302 to a signed
blob-storage URL, and that blob store rejects any request carrying an
`Authorization` header (HTTP 400 InvalidAuthenticationInfo). So the redirect
must be taken WITHOUT the auth header:

  1. request the API endpoint with auth, do not follow the redirect
  2. GET the Location with no Authorization header at all

Verified 2026-11-04 against job 126332888366: naive follow -> 403/401,
two-step -> HTTP 200, 18473 bytes.

Usage:
    GH_TOKEN=... python3 scripts/fetch_job_logs.py \
        --repo XuJianrui/cordis --out evidence/statistical/raw_logs \
        --runs 41319092304,41401117722,...
"""
import argparse
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_NO_REDIRECT = urllib.request.build_opener(_NoRedirect)


def _api(url: str, token: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "cedar-evidence/1.0",
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + token,
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_job_log(repo: str, job_id: int, token: str, timeout: int = 180) -> bytes:
    """Return the raw log text for one job, handling the signed-URL redirect."""
    url = f"https://api.github.com/repos/{repo}/actions/jobs/{job_id}/logs"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "cedar-evidence/1.0",
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + token,
        },
    )
    try:
        with _NO_REDIRECT.open(req, timeout=60) as r:
            # some tokens get the log body directly
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307, 308):
            raise RuntimeError(f"job {job_id}: HTTP {e.code} {e.read()[:200]!r}")
        location = e.headers.get("Location")
    if not location:
        raise RuntimeError(f"job {job_id}: redirect without Location")

    host = urllib.parse.urlparse(location).hostname
    if not host or not host.endswith(("blob.core.windows.net", "githubusercontent.com")):
        raise RuntimeError(f"job {job_id}: unexpected redirect host {host!r}")

    # Second hop carries NO Authorization header on purpose.
    req2 = urllib.request.Request(location, headers={"User-Agent": "cedar-evidence/1.0"})
    with urllib.request.urlopen(req2, timeout=timeout) as r2:
        return r2.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--runs", required=True, help="comma-separated run ids")
    ap.add_argument("--sleep", type=float, default=0.25, help="pause between job fetches")
    args = ap.parse_args()

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        print("ERROR: set GH_TOKEN or GITHUB_TOKEN", file=sys.stderr)
        return 2

    args.out.mkdir(parents=True, exist_ok=True)
    run_ids = [int(x) for x in args.runs.split(",") if x.strip()]

    saved = 0
    failed = 0
    report = []
    for rid in run_ids:
        try:
            jobs = json.loads(
                _api(f"https://api.github.com/repos/{args.repo}/actions/runs/{rid}/jobs?per_page=100", token)
            ).get("jobs", [])
        except Exception as e:  # noqa: BLE001
            print(f"run {rid}: cannot list jobs: {e}", file=sys.stderr)
            failed += 1
            continue

        for job in jobs:
            if job.get("conclusion") not in ("success", "failure"):
                continue
            jid = job["id"]
            dest = args.out / f"{rid}_{jid}.log.gz"
            if dest.exists():
                saved += 1
                continue
            try:
                data = fetch_job_log(args.repo, jid, token)
            except Exception as e:  # noqa: BLE001
                print(f"  job {jid}: {e}", file=sys.stderr)
                failed += 1
                continue
            with gzip.open(dest, "wb") as f:
                f.write(data)
            saved += 1
            report.append({"run": rid, "job": jid, "name": job.get("name"), "bytes": len(data)})
            print(f"  saved {dest.name} ({len(data)} bytes) [{job.get('name')}]")
            time.sleep(args.sleep)

    manifest = args.out / "manifest.json"
    manifest.write_text(json.dumps({"saved": saved, "failed": failed, "entries": report}, indent=2))
    print(f"saved={saved} failed={failed} -> {manifest}")
    return 0 if saved else 1


if __name__ == "__main__":
    raise SystemExit(main())
