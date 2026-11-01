#!/usr/bin/env bash
# Probe 262: the guest account may be disabled, which would reject guest SMB
# even when the share says "guest access: 1". Turn it on and retry.
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
BASE="$RT/probe262-roots"; mkdir -p "$BASE"
status() { echo "$1=$2" >> "$STATUS"; }
add() { echo "$1=$2" >> "$ROOTS"; status "$1" ok; }

echo "--- guest before"; sudo sysadminctl -guestAccount status 2>&1 || true
sudo sysadminctl -guestAccount on 2>&1 || true
echo "--- guest after"; sudo sysadminctl -guestAccount status 2>&1 || true

SHARE=/Users/Shared/probe262
sudo mkdir -p "$SHARE" && sudo chmod 777 "$SHARE"
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.smbd.plist >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist AllowGuestAccess -bool true >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist GuestAccess -bool true >/dev/null 2>&1 || true
sudo sharing -r share >/dev/null 2>&1 || true
sudo sharing -a "$SHARE" -S share >/dev/null 2>&1 || true
sudo launchctl kickstart -k system/com.apple.smbd >/dev/null 2>&1 || true
sleep 3

mkdir -p "$BASE/smb"
for target in \
  "//guest@127.0.0.1/share" \
  "//Guest@127.0.0.1/share" \
  "//nobody@127.0.0.1/share" \
  "//guest:@127.0.0.1/share"; do
  echo "--- mount $target"
  if perl -e 'alarm 20; exec @ARGV' mount_smbfs -N "$target" "$BASE/smb" 2>&1; then
    add smb "$BASE/smb"; status smb-target "$target"; break
  fi
done

echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
