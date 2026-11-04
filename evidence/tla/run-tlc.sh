#!/usr/bin/env bash
# Runs TLC four times and asserts the *expected* outcome of each run.
#
# A model checker that always says "NoError" proves nothing; a model checker
# that always says "violated" proves nothing either. Three of these runs are
# expected to find a violation, and the run is only green when the checker
# reports exactly what the design says it should.
set -uo pipefail

JAR="${TLA_JAR:-/tmp/tla2tools.jar}"
SPEC="ctxfs.tla"
FAILED=0

run_case () {
    local name="$1" cfg="$2" expect="$3"
    echo "----------------------------------------------------------------"
    echo "CASE $name  (expect: $expect)"

    local out
    out=$(java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
            -config "$cfg" -workers 2 -deadlock \
            "$SPEC" 2>&1)
    local rc=$?
    local verdict

    if echo "$out" | grep -q "No error has been found"; then
        verdict="clean"
    elif echo "$out" | grep -q "is violated"; then
        verdict="violated"
    elif echo "$out" | grep -qi "error\|exception"; then
        verdict="error"
    else
        verdict="unknown"
    fi

    echo "  verdict: $verdict (rc=$rc)"

    # surface the invariant name and the first few trace lines
    echo "$out" | grep -E "Invariant .* is violated|Error: |State [0-9]+:" | head -8

    if [ "$verdict" = "$expect" ]; then
        echo "  RESULT: PASS"
    else
        echo "  RESULT: FAIL  (wanted $expect)"
        echo "  ---- last 40 lines ----"
        echo "$out" | tail -40
        FAILED=$((FAILED + 1))
    fi
    echo
}

run_case "cleared   - contract holds"        MC-cleared.cfg    clean
run_case "uncleared - duplicate reachable"   MC-uncleared.cfg  violated
run_case "stale     - stale reg reachable"   MC-stale.cfg      violated

echo "================================================================"
if [ "$FAILED" -ne 0 ]; then
    echo "TLC: $FAILED case(s) did not match the expected outcome"
    exit 1
fi
echo "TLC: all 3 cases matched their expected outcome"
