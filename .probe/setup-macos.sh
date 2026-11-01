#!/usr/bin/env bash
# Probe 262: find smbd wherever Homebrew put it, then mount the share.
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
BASE="$RT/probe262-roots"; mkdir -p "$BASE"
status() { echo "$1=$2" >> "$STATUS"; }
add() { echo "$1=$2" >> "$ROOTS"; status "$1" ok; }

sudo launchctl unload -w /System/Library/LaunchDaemons/com.apple.smbd.plist >/dev/null 2>&1 || true
sudo pkill -x smbd >/dev/null 2>&1 || true
sleep 2

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$PATH"
if perl -e 'alarm 420; exec @ARGV' brew install samba > "$RT/brew.log" 2>&1; then
  SMBD="$(find /opt/homebrew -name smbd -type f 2>/dev/null | head -1)"
  TESTPARM="$(find /opt/homebrew -name testparm -type f 2>/dev/null | head -1)"
  echo "--- smbd $SMBD"
  echo "--- testparm $TESTPARM"
  mkdir -p "$BASE/smbshare" "$BASE/smb-run" "$BASE/smb"
  chmod 777 "$BASE/smbshare"
  cat > "$BASE/smb.conf" <<CONF
[global]
  workgroup = WORKGROUP
  server role = standalone server
  server min protocol = SMB2
  map to guest = bad user
  guest account = nobody
  pid directory = $BASE/smb-run
  lock directory = $BASE/smb-run
  state directory = $BASE/smb-run
  cache directory = $BASE/smb-run
  private dir = $BASE/smb-run
  ncalrpc dir = $BASE/smb-run
  log file = $BASE/smb-run/log.%m
[probe262]
  path = $BASE/smbshare
  read only = no
  guest ok = yes
  force user = $(whoami)
CONF
  echo "--- start"
  sudo "$SMBD" -F --no-process-group -s "$BASE/smb.conf" -p 445 > "$RT/smbd.out" 2>&1 &
  sleep 6
  echo "--- out"; cat "$RT/smbd.out" 2>/dev/null || true
  echo "--- 445"; lsof -nP -i :445 || echo free
  for target in "//guest:@localhost/probe262" "//guest@localhost/probe262"; do
    echo "--- mount $target"
    if perl -e 'alarm 20; exec @ARGV' mount_smbfs -N "$target" "$BASE/smb" 2>&1; then
      add smb "$BASE/smb"; status smb-target "$target"; break
    fi
  done
else
  status smb-brew fail-install
fi

echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
