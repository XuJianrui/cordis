#!/usr/bin/env python3
"""
Bootstrap 10k resamples for all probe readings extracted from CI logs.
Produces BCa 95% CI, power analysis, and multiple comparison correction.
"""
import argparse
import gzip
import json
import re
import sys
from pathlib import Path

import numpy as np
from scipy import stats
from scipy.stats import bootstrap

# Reading patterns to extract from logs
PATTERNS = {
    # Adjudication probe readings
    'adj_iter_raw_path': r'ADJ_ITER_RAW_PATH\s*=\s*([0-9]+)',
    'adj_iter_write': r'ADJ_ITER_WRITE\s*=\s*([0-9]+)',
    'adj_iter_first': r'ADJ_ITER_FIRST\s*=\s*(\{.*?\})',
    'adj_iter_raw': r'ADJ_ITER_RAW\s*=\s*([0-9]+)',
    # N6 probe readings
    'n6_events': r'N6_EVENTS\s*=\s*([0-9]+)',
    'n6_seeds': r'N6_SEEDS\s*=\s*([0-9]+)',
    # Conformance readings
    'conf_write': r'CONF_WRITE\s*=\s*([0-9]+)',
    'conf_stop': r'CONF_STOP\s*=\s*([0-9]+)',
    'conf_iterator': r'CONF_ITERATOR\s*=\s*([0-9]+)',
    'conf_delete': r'CONF_DELETE\s*=\s*([0-9]+)',
    'conf_reresolve': r'CONF_RERESOLVE\s*=\s*([0-9]+)',
    # Layer probe readings (per layer)
    'l0_file_raw': r'L0_fileRaw\s*=\s*([0-9]+)',
    'l1_dir_raw': r'L1_dirRaw\s*=\s*([0-9]+)',
    'l2_chokidar': r'L2_chokidar\s*=\s*([0-9]+)',
    'l3_ctxfs': r'L3_ctxfs\s*=\s*([0-9]+)',
    # Torn/control/drop readings
    'torn_control_readback': r'TORN_CONTROL_READBACK\s*=\s*([0-9]+)',
    'torn_first_byte': r'TORN_FIRST_BYTE\s*=\s*([0-9]+)',
    'inflight_writes': r'INFLIGHT_WRITES\s*=\s*([0-9]+)',
    'drop_writes': r'DROP_WRITES\s*=\s*([0-9]+)',
    'power_cut': r'POWER_CUT\s*=\s*([0-9]+)',
}

COMPILED = {k: re.compile(v) for k, v in PATTERNS.items()}

def extract_readings(log_text: str) -> dict:
    """Extract all structured readings from a single log."""
    readings = {}
    for key, pattern in COMPILED.items():
        matches = pattern.findall(log_text)
        if matches:
            readings[key] = [int(m) if m.isdigit() else m for m in matches]
    return readings

def bootstrap_ci(data: np.ndarray, n_resamples: int = 10000, confidence: float = 0.95) -> dict:
    """Compute BCa bootstrap confidence interval for mean."""
    if len(data) < 2:
        return {"mean": float(np.mean(data)), "ci_low": None, "ci_high": None, "n": len(data)}
    try:
        res = bootstrap((data,), np.mean, n_resamples=n_resamples, confidence_level=confidence, method='bca')
        return {
            "mean": float(np.mean(data)),
            "ci_low": float(res.confidence_interval.low),
            "ci_high": float(res.confidence_interval.high),
            "n": len(data),
            "method": "BCa"
        }
    except Exception as e:
        # Fallback to percentile
        try:
            res = bootstrap((data,), np.mean, n_resamples=n_resamples, confidence_level=confidence, method='percentile')
            return {
                "mean": float(np.mean(data)),
                "ci_low": float(res.confidence_interval.low),
                "ci_high": float(res.confidence_interval.high),
                "n": len(data),
                "method": "percentile"
            }
        except:
            return {"mean": float(np.mean(data)), "ci_low": None, "ci_high": None, "n": len(data), "error": str(e)}

def power_analysis(effect_size: float, alpha: float = 0.05, n: int = 60) -> float:
    """Compute statistical power for one-sample t-test."""
    from scipy.stats import t
    # Non-centrality parameter
    ncp = effect_size * np.sqrt(n)
    crit = t.ppf(1 - alpha/2, n - 1)
    power = 1 - t.cdf(crit, n - 1, ncp) + t.cdf(-crit, n - 1, ncp)
    return float(power)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input-dir', required=True, type=Path)
    ap.add_argument('--output-dir', required=True, type=Path)
    ap.add_argument('--resamples', type=int, default=10000)
    ap.add_argument('--confidence', type=float, default=0.95)
    args = ap.parse_args()

    input_dir = args.input_dir
    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    all_readings = {k: [] for k in PATTERNS.keys()}
    all_readings['run_id'] = []
    all_readings['job_id'] = []

    # Process each log file
    log_files = list(input_dir.glob('*.log.gz'))
    print(f"Processing {len(log_files)} log files...")
    for log_file in log_files:
        # Parse run_id and job_id from filename
        match = re.match(r'(\d+)_(\d+)\.log\.gz', log_file.name)
        if not match:
            continue
        run_id, job_id = match.groups()

        with gzip.open(log_file, 'rt', encoding='utf-8', errors='replace') as f:
            content = f.read()

        readings = extract_readings(content)
        if not readings:
            continue

        for key, values in readings.items():
            all_readings[key].extend(values)
        all_readings['run_id'].extend([run_id] * len(next(iter(readings.values()))))
        all_readings['job_id'].extend([job_id] * len(next(iter(readings.values()))))

    # Compute statistics per reading type
    results = {}
    for key in PATTERNS.keys():
        data = np.array(all_readings[key], dtype=float)
        if len(data) == 0:
            continue

        # Basic stats
        ci = bootstrap_ci(data, args.resamples, args.confidence)

        # Effect size vs 1.0 (for count ratios)
        if key in ('adj_iter_raw_path', 'adj_iter_write', 'n6_events', 'l0_file_raw', 'l1_dir_raw', 'l2_chokidar', 'l3_ctxfs'):
            effect_size = (np.mean(data) - 1.0) / np.std(data) if np.std(data) > 0 else 0
            power = power_analysis(effect_size, n=len(data))
        else:
            power = None

        results[key] = {
            "raw_values": data.tolist(),
            "count": len(data),
            "mean": float(np.mean(data)),
            "std": float(np.std(data)),
            "median": float(np.median(data)),
            "min": float(np.min(data)),
            "max": float(np.max(data)),
            "bootstrap_ci": ci,
            "power_vs_1.0": power
        }

    # Multiple comparison correction (Holm-Bonferroni)
    p_values = []
    for key, res in results.items():
        if res['power_vs_1.0'] is not None:
            # Two-sided t-test vs 1.0
            data = np.array(res['raw_values'])
            t_stat, p = stats.ttest_1samp(data, 1.0)
            p_values.append((key, p, t_stat))

    # Holm-Bonferroni
    p_values.sort(key=lambda x: x[1])
    m = len(p_values)
    holm_results = {}
    for i, (key, p, t_stat) in enumerate(p_values):
        alpha_holm = 0.05 / (m - i)
        holm_results[key] = {
            "p_value": p,
            "t_statistic": float(t_stat),
            "holm_threshold": alpha_holm,
            "significant_after_holm": p < alpha_holm
        }

    # Summary JSON
    summary = {
        "metadata": {
            "log_files_processed": len(log_files),
            "total_readings": sum(len(v) for k, v in all_readings.items() if k in PATTERNS),
            "bootstrap_resamples": args.resamples,
            "confidence_level": args.confidence,
            "correction_method": "Holm-Bonferroni"
        },
        "readings": results,
        "multiple_comparison": holm_results
    }

    # Write outputs
    with open(output_dir / 'summary.json', 'w') as f:
        json.dump(summary, f, indent=2)

    # CSV for easy reading
    import csv
    with open(output_dir / 'readings_summary.csv', 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['reading', 'count', 'mean', 'std', 'median', 'ci_low', 'ci_high', 'ci_method', 'power_vs_1.0', 'holm_significant'])
        for key, res in results.items():
            ci = res['bootstrap_ci']
            holm = holm_results.get(key, {})
            writer.writerow([
                key, res['count'], res['mean'], res['std'], res['median'],
                ci.get('ci_low'), ci.get('ci_high'), ci.get('method'),
                res.get('power_vs_1.0'),
                holm.get('significant_after_holm', 'N/A')
            ])

    print(f"Results written to {output_dir}")
    print(f"  summary.json: {len(results)} readings")
    print(f"  readings_summary.csv: ready")

if __name__ == '__main__':
    main()