#!/usr/bin/env python3
"""Bootstrap statistics over the probe readings that actually appear in CI logs.

The probes print lines of the form

    <timestamp> ADJ_LAYER = {"i":1,"L0_fileRaw":2,"L1_dirRaw":2,"L2_chokidar":1,"L3_ctxfs":1,"writes":1}
    <timestamp> ADJ_ITER_READY_MS = 7
    <timestamp> ADJ_ITER_STATS = {"rawCallbacks":0,"afterStopCallbacks":0}
    <timestamp> CONF_DELETE = SKIP capability=false

so the extractor parses `KEY = <json-or-scalar>` rather than guessing at
`KEY=<number>`. Numeric JSON fields are flattened to `KEY.field`; everything
else is kept as a categorical tally, because a boolean capability is not a
measurement and must not be averaged.

Two families are computed separately:

  readings      one value per occurrence (latencies, counters)
  per-job ratios  for ADJ_LAYER, the last row of each job gives writes and the
                  four layer counters; the ratio layer/writes is one sample per
                  job, which is the quantity the comments quote as "1.00" / "1.98x"

Usage:
    python3 scripts/bootstrap_analysis.py \
        --input-dir evidence/statistical/raw_logs \
        --output-dir evidence/statistical \
        --resamples 10000 --confidence 0.95
"""
import argparse
import gzip
import json
import re
import statistics
import sys
from pathlib import Path

import numpy as np
from scipy import stats
from scipy.stats import bootstrap

# <timestamp> KEY = value   (timestamp optional: local runs have none)
# GitHub colourises its logs, so ANSI escapes sit between the timestamp and the key.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
LINE_RE = re.compile(r"^(?:\d{4}-\d\d-\d\dT\S+Z\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$")

LAYER_FIELDS = ("L0_fileRaw", "L1_dirRaw", "L2_chokidar", "L3_ctxfs")


def flatten(prefix, value, numeric, categorical):
    """Split a parsed JSON value into numeric / categorical observations."""
    if isinstance(value, bool):
        categorical[f"{prefix}={str(value).lower()}"] = (
            categorical.get(f"{prefix}={str(value).lower()}", 0) + 1
        )
    elif isinstance(value, (int, float)):
        numeric.setdefault(prefix, []).append(float(value))
    elif isinstance(value, str):
        key = f"{prefix}={value}"
        categorical[key] = categorical.get(key, 0) + 1
    elif isinstance(value, dict):
        for k, v in value.items():
            flatten(f"{prefix}.{k}", v, numeric, categorical)
    elif isinstance(value, list):
        numeric.setdefault(f"{prefix}.__len", []).append(float(len(value)))
        for item in value:
            if isinstance(item, dict):
                for k, v in item.items():
                    flatten(f"{prefix}.{k}", v, numeric, categorical)


def parse_log(text):
    """Return (numeric dict, categorical Counter, per-job layer finals)."""
    numeric = {}
    categorical = {}
    layer_rows = []

    for raw_line in text.splitlines():
        line = ANSI_RE.sub("", raw_line).strip()
        m = LINE_RE.match(line)
        if not m:
            continue
        key, rhs = m.group(1), m.group(2).strip()
        if not rhs:
            continue
        try:
            value = json.loads(rhs)
        except (json.JSONDecodeError, ValueError):
            # not JSON: a bare number, else a categorical token like "SKIP capability=false"
            try:
                numeric.setdefault(key, []).append(float(rhs))
            except ValueError:
                tok = rhs.split()[0] if rhs.split() else ""
                ck = f"{key}={tok}"
                categorical[ck] = categorical.get(ck, 0) + 1
            continue

        if key == "ADJ_LAYER" and isinstance(value, dict):
            layer_rows.append(value)
        flatten(key, value, numeric, categorical)

    return numeric, categorical, layer_rows


def bootstrap_ci(data, n_resamples, confidence):
    """BCa interval for the mean, falling back to percentile when BCa fails."""
    arr = np.asarray(data, dtype=float)
    if arr.size == 0:
        return {"n": 0}
    if arr.size == 1:
        return {"n": 1, "mean": float(arr[0]), "ci_low": None, "ci_high": None,
                "method": "insufficient-n"}
    if float(np.std(arr)) == 0.0:
        v = float(arr[0])
        return {"n": int(arr.size), "mean": v, "ci_low": v, "ci_high": v,
                "method": "degenerate-zero-variance"}
    for method in ("bca", "percentile"):
        try:
            res = bootstrap((arr,), np.mean, n_resamples=n_resamples,
                            confidence_level=confidence, method=method)
            return {
                "n": int(arr.size),
                "mean": float(np.mean(arr)),
                "ci_low": float(res.confidence_interval.low),
                "ci_high": float(res.confidence_interval.high),
                "method": method,
            }
        except Exception:  # noqa: BLE001 — fall through to percentile, then give up
            continue
    return {"n": int(arr.size), "mean": float(np.mean(arr)), "ci_low": None,
            "ci_high": None, "method": "failed"}


def power_one_sample(effect_size, n, alpha=0.05):
    """Power of a two-sided one-sample t-test at the given standardised effect."""
    if n < 2 or effect_size <= 0:
        return None
    ncp = effect_size * np.sqrt(n)
    crit = stats.t.ppf(1 - alpha / 2, n - 1)
    return float(1 - stats.t.cdf(crit, n - 1, ncp) + stats.t.cdf(-crit, n - 1, ncp))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True, type=Path)
    ap.add_argument("--output-dir", required=True, type=Path)
    ap.add_argument("--resamples", type=int, default=10000)
    ap.add_argument("--confidence", type=float, default=0.95)
    args = ap.parse_args()

    out_dir = args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    logs = sorted(args.input_dir.glob("*.log.gz"))
    print(f"log files: {len(logs)}")

    numeric_all = {}
    categorical_all = {}
    ratios = {f"{f}_per_write": [] for f in LAYER_FIELDS}
    ratio_sources = []
    parsed = 0

    for log_path in logs:
        try:
            with gzip.open(log_path, "rt", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError as e:
            print(f"  skip {log_path.name}: {e}", file=sys.stderr)
            continue

        num, cat, layers = parse_log(text)
        if not num and not cat:
            continue
        parsed += 1

        for k, vs in num.items():
            numeric_all.setdefault(k, []).extend(vs)
        for k, c in cat.items():
            categorical_all[k] = categorical_all.get(k, 0) + c

        # one sample per job: the last ADJ_LAYER row of this log
        if layers:
            last = layers[-1]
            writes = last.get("writes")
            if isinstance(writes, (int, float)) and writes > 0:
                for fld in LAYER_FIELDS:
                    v = last.get(fld)
                    if isinstance(v, (int, float)):
                        ratios[f"{fld}_per_write"].append(float(v) / float(writes))
                ratio_sources.append({
                    "log": log_path.name,
                    "writes": writes,
                    **{f: last.get(f) for f in LAYER_FIELDS},
                })

    print(f"logs with readings: {parsed}/{len(logs)}")
    print(f"distinct numeric fields: {len(numeric_all)}")
    print(f"per-job layer rows: {len(ratio_sources)}")

    readings = {}
    for key, vals in sorted(numeric_all.items()):
        if not vals:
            continue
        arr = np.asarray(vals, dtype=float)
        if arr.size == 0:
            continue
        ci = bootstrap_ci(arr, args.resamples, args.confidence)
        readings[key] = {
            "count": int(arr.size),
            "mean": float(np.mean(arr)),
            "std": float(np.std(arr, ddof=1)) if arr.size > 1 else 0.0,
            "median": float(np.median(arr)),
            "min": float(np.min(arr)),
            "max": float(np.max(arr)),
            "bootstrap_ci": ci,
        }

    ratio_results = {}
    p_pairs = []
    for key, vals in ratios.items():
        if not vals:
            continue
        arr = np.asarray(vals, dtype=float)
        ci = bootstrap_ci(arr, args.resamples, args.confidence)
        sd = float(np.std(arr, ddof=1)) if arr.size > 1 else 0.0
        effect = abs(float(np.mean(arr)) - 1.0) / sd if sd > 0 else 0.0
        pw = power_one_sample(effect, arr.size)
        ratio_results[key] = {
            "samples": [float(x) for x in arr],
            "count": int(arr.size),
            "mean": float(np.mean(arr)),
            "std": sd,
            "min": float(np.min(arr)),
            "max": float(np.max(arr)),
            "bootstrap_ci": ci,
            "power_vs_1.0": pw,
            "effect_size_vs_1.0": effect,
        }
        if arr.size > 1 and sd > 0:
            t_stat, p = stats.ttest_1samp(arr, 1.0)
            p_pairs.append((key, float(p), float(t_stat)))

    p_pairs.sort(key=lambda x: x[1])
    m = len(p_pairs)
    holm = {}
    for i, (key, p, t) in enumerate(p_pairs):
        thr = 0.05 / (m - i)
        holm[key] = {
            "p_value": p,
            "t_statistic": t,
            "holm_threshold": thr,
            "significant_after_holm": p < thr,
        }

    summary = {
        "metadata": {
            "log_files": len(logs),
            "logs_with_readings": parsed,
            "per_job_layer_rows": len(ratio_sources),
            "numeric_fields": len(numeric_all),
            "bootstrap_resamples": args.resamples,
            "confidence_level": args.confidence,
            "correction_method": "Holm-Bonferroni (ratios only)",
            "note": (
                "Counters are counts, not proportions: Wilson intervals do not apply. "
                "Ratios are per job (last ADJ_LAYER row), so n = number of jobs, not writes."
            ),
        },
        "readings": readings,
        "ratios": ratio_results,
        "categorical": dict(sorted(categorical_all.items())),
        "ratio_sources": ratio_sources,
        "multiple_comparison": holm,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))

    import csv
    with open(out_dir / "readings_summary.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["family", "key", "n", "mean", "std", "min", "max",
                    "ci_low", "ci_high", "ci_method", "power_vs_1.0", "holm_significant"])
        for family, block in (("reading", readings), ("ratio", ratio_results)):
            for k, v in block.items():
                ci = v["bootstrap_ci"]
                h = holm.get(k, {})
                w.writerow([
                    family, k, v["count"], f"{v['mean']:.6g}", f"{v.get('std', 0):.6g}",
                    f"{v['min']:.6g}", f"{v['max']:.6g}",
                    ci.get("ci_low"), ci.get("ci_high"), ci.get("method"),
                    v.get("power_vs_1.0"),
                    h.get("significant_after_holm", ""),
                ])

    # human-readable digest for the job summary
    lines = []
    lines.append("### Ratios (one sample per job)")
    lines.append("")
    lines.append("| ratio | n | mean | 95% CI | min–max |")
    lines.append("| :--- | :-- | :--- | :--- | :--- |")
    for k, v in ratio_results.items():
        ci = v["bootstrap_ci"]
        lines.append(
            f"| {k} | {v['count']} | {v['mean']:.3f} | "
            f"[{ci.get('ci_low')}, {ci.get('ci_high')}] | {v['min']:.2f}–{v['max']:.2f} |"
        )
    (out_dir / "digest.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {out_dir/'summary.json'}")


if __name__ == "__main__":
    main()
