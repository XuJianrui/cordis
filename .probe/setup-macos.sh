#!/usr/bin/env bash
# Probe 262: macOS SMB access is gated by com.apple.access_smb. Add the account
# to that group before concluding authentication cannot work.
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

sudo sysadminctl -addUser probe262 -password probe262pw -admin >/dev/null 2>&1 || true
sudo dseditgroup -o create com.apple.access_smb >/dev/null 2>&1 || true
sudo dseditgroup -o edit -a probe262 -t user com.apple.access_smb >/dev/null 2>&1 || true
sudo dseditgroup -o edit -a runner -t user com.apple.access_smb >/dev/null 2>&1 || true
sudo launchctl kickstart -k system/com.apple.smbd >/dev/null 2>&1 || true
sleep 3

echo "--- access_smb"
dscl . -read /Groups/com.apple.access_smb 2>&1 || true
echo "--- view as probe262"
smbutil view -N //probe262:probe262pw@localhost 2>&1 || true
mkdir -p "$BASE/smb"
for target in \
  "//probe262:probe262pw@localhost/probe262" \
  "//probe262:probe262pw@127.0.0.1/probe262" \
  "//guest:@localhost/probe262"; do
  echo "--- mount $target"
  if perl -e 'alarm 20; exec @ARGV' mount_smbfs -N "$target" "$BASE/smb" 2>&1; then
    add smb "$BASE/smb"; status smb-target "$target"; break
  fi
done

echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
