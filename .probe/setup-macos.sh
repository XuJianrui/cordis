#!/usr/bin/env bash
# Probe 262: can a runner reach an external SMB server on 445?
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
echo "--- 445 to test.rebex.net"
nc -z -v -w 5 test.rebex.net 445 2>&1 || echo "445 blocked"
echo "--- 443 control"
nc -z -v -w 5 test.rebex.net 443 2>&1 || echo "443 blocked"
echo "--- 445 to 1.1.1.1"
nc -z -v -w 5 1.1.1.1 445 2>&1 || echo "445 blocked"
