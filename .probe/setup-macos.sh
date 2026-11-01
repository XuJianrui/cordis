#!/usr/bin/env bash
# Probe 262: SMB guest-auth spellings only. The share and smbd are already
# known to be up; this isolates how mount_smbfs passes a guest identity.
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
BASE="$RT/probe262-roots"; mkdir -p "$BASE"
status() { echo "$1=$2" >> "$STATUS"; }
add() { echo "$1=$2" >> "$ROOTS"; status "$1" ok; }

mkdir -p "$BASE/smbshare" && chmod 777 "$BASE/smbshare"
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.smbd.plist >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist AllowGuestAccess -bool true >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist GuestAccess -bool true >/dev/null 2>&1 || true
sudo sharing -a "$BASE/smbshare" -S probe262 >/dev/null 2>&1 || true
sudo launchctl kickstart -k system/com.apple.smbd >/dev/null 2>&1 || true
sleep 3

mkdir -p "$BASE/smb"
echo "--- view guest user"
smbutil view -N //guest@localhost 2>&1 || true
for target in \
  "//guest:@localhost/probe262" \
  "//guest:@127.0.0.1/probe262" \
  "//guest@localhost/probe262"; do
  echo "--- mount $target"
  if perl -e 'alarm 20; exec @ARGV' mount_smbfs -N "$target" "$BASE/smb" 2>&1; then
    add smb "$BASE/smb"
    status smb-target "$target"
    break
  fi
done

echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
