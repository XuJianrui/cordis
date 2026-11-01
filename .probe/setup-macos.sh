#!/usr/bin/env bash
# Probe 262: built-in smbd with the share under /Users/Shared (guest `nobody`
# can traverse it), mounted over 127.0.0.1. Also look for a samba smbd symlink.
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
BASE="$RT/probe262-roots"; mkdir -p "$BASE"
status() { echo "$1=$2" >> "$STATUS"; }
add() { echo "$1=$2" >> "$ROOTS"; status "$1" ok; }

SHARE=/Users/Shared/probe262
sudo mkdir -p "$SHARE" && sudo chmod 777 "$SHARE"
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.smbd.plist >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist AllowGuestAccess -bool true >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist GuestAccess -bool true >/dev/null 2>&1 || true
sudo sharing -r share >/dev/null 2>&1 || true
sudo sharing -a "$SHARE" -S share >/dev/null 2>&1 || true
sudo launchctl kickstart -k system/com.apple.smbd >/dev/null 2>&1 || true
sleep 3

echo "--- sharing"; sudo sharing -l 2>&1 | head -20
echo "--- samba smbd candidates"
find /opt/homebrew -name 'smbd*' 2>/dev/null | head -5 || true
ls /opt/homebrew/sbin/smbd 2>/dev/null || true

mkdir -p "$BASE/smb"
for target in \
  "//guest@127.0.0.1/share" \
  "//guest:@127.0.0.1/share" \
  "//guest@localhost/share"; do
  echo "--- mount $target"
  if perl -e 'alarm 20; exec @ARGV' mount_smbfs -N "$target" "$BASE/smb" 2>&1; then
    add smb "$BASE/smb"; status smb-target "$target"; break
  fi
done

echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
