#!/usr/bin/env bash
# Probe 262: prepare non-default filesystem roots on macos-latest.
# The runner volume is APFS, case-insensitive by default; the probe records it.
# Every mount is best-effort: a failure is recorded in mount-status.txt.
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
sudo launchctl kickstart -k system/com.apple.nfsd >/dev/null 2>&1 || true
sleep 2
status nfsd "$(sudo nfsd status 2>&1 | tr '\n' ' ' | cut -c1-120)"
{
  command -v rpcinfo && sudo "$(command -v rpcinfo)" -p localhost
  command -v showmount && sudo "$(command -v showmount)" -e localhost
} > "$RT/nfs-diag.txt" 2>&1 || true

mkdir -p "$BASE/nfs"
mounted=0
for opts in \
  "vers=4,soft,timeo=10,retrans=1" \
  "nfsvers=4,soft,timeo=10" \
  "vers=4,resvport,soft,timeo=10" \
  "vers=4,tcp,soft,timeo=10" \
  "vers=3,soft,timeo=10"; do
  if sudo mount -t nfs -o "$opts" "localhost:$BASE/nfsshare" "$BASE/nfs" 2>>"$STATUS"; then
    add nfs "$BASE/nfs"
    mounted=1
    break
  fi
done
[ "$mounted" = 1 ] || status nfs fail-mount

# --- SMB via the built-in smbd: the other network path macOS ships -------------
mkdir -p "$BASE/smbshare" && chmod 777 "$BASE/smbshare"
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.smbd.plist >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist EnabledServices -array disk >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist AllowGuestAccess -bool true >/dev/null 2>&1 || true
sudo sharing -a "$BASE/smbshare" -S probe262 >/dev/null 2>&1 || true
sudo launchctl kickstart -k system/com.apple.smbd >/dev/null 2>&1 || true
sleep 2
mkdir -p "$BASE/smb"
if mount_smbfs -N "//guest@localhost/probe262" "$BASE/smb" 2>>"$STATUS"; then
  add smb "$BASE/smb"
else
  status smb fail-mount
fi

echo "--- nfs diag"; cat "$RT/nfs-diag.txt" 2>/dev/null || true
echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
