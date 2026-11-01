#!/usr/bin/env bash
# Probe 262: SMB diagnostics only. No installs, no other mounts, so the output
# always prints before any budget can expire.
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
BASE="$RT/probe262-roots"; mkdir -p "$BASE"

status() { echo "$1=$2" >> "$STATUS"; }
add() { echo "$1=$2" >> "$ROOTS"; status "$1" ok; }

mkdir -p "$BASE/smbshare" && chmod 777 "$BASE/smbshare"
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.smbd.plist >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist EnabledServices -array disk >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist AllowGuestAccess -bool true >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist GuestAccess -bool true >/dev/null 2>&1 || true
sudo sharing -a "$BASE/smbshare" -S probe262 >/dev/null 2>&1 || true
sudo launchctl kickstart -k system/com.apple.smbd >/dev/null 2>&1 || true
sleep 3

{
  echo "--- sharing"; sudo sharing -l || true
  echo "--- launchctl"; sudo launchctl list | grep -i smbd || true
  echo "--- lsof"; sudo lsof -nP -i :445 || true
  echo "--- view guest"; sudo smbutil view -N //localhost || true
  echo "--- auth"; dscl . -read /Users/runner AuthenticationAuthority || true
} > "$RT/smb4-diag.txt" 2>&1
cat "$RT/smb4-diag.txt"

mkdir -p "$BASE/smb"
echo "--- mount guest"
perl -e 'alarm 20; exec @ARGV' mount_smbfs -N "//guest@localhost/probe262" "$BASE/smb" 2>&1 || true
echo "--- mount runner"
perl -e 'alarm 20; exec @ARGV' mount_smbfs -N "//runner:probe262pw@localhost/probe262" "$BASE/smb" 2>&1 || true

echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
