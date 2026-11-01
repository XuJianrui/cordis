#!/usr/bin/env bash
# Probe 262: prepare non-default filesystem roots on macos-latest.
# The runner volume is APFS, case-insensitive by default; the probe records it.
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
BASE="$RT/probe262-roots"; mkdir -p "$BASE"

status() { echo "$1=$2" >> "$STATUS"; }
add() { echo "$1=$2" >> "$ROOTS"; status "$1" ok; }

mkdir -p "$BASE/local"
add local "$BASE/local"

# --- NFS: local export, mounted through the loopback interface -----------------
mkdir -p "$BASE/nfsshare" && chmod 777 "$BASE/nfsshare"
printf '%s -alldirs -mapall=%s:%s\n' "$BASE/nfsshare" "$(id -u)" "$(id -g)" | sudo tee /etc/exports >/dev/null
# `nfsd enable` is gone on recent macOS; the daemon is a launchd job.
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.nfsd.plist >/dev/null 2>&1 || true
sudo nfsd update >/dev/null 2>&1 || true
sudo nfsd start >/dev/null 2>&1 || true
sleep 2
status nfsd "$(sudo nfsd status 2>&1 | tr '\n' ' ' | cut -c1-120)"
mkdir -p "$BASE/nfs"
if sudo mount -t nfs -o vers=4,resvport,soft "localhost:$BASE/nfsshare" "$BASE/nfs" 2>>"$STATUS"; then
  add nfs "$BASE/nfs"
else
  status nfs fail-mount
fi

echo "--- nfs diag"; cat "$RT/nfs-diag.txt" 2>/dev/null || true
echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
