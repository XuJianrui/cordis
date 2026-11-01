#!/usr/bin/env bash
# Probe 262: free port 445 from the built-in smbd, then let Homebrew Samba bind
# it. The earlier samba runs failed because launchd already held 445.
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
BASE="$RT/probe262-roots"; mkdir -p "$BASE"
status() { echo "$1=$2" >> "$STATUS"; }
add() { echo "$1=$2" >> "$ROOTS"; status "$1" ok; }

sudo launchctl unload -w /System/Library/LaunchDaemons/com.apple.smbd.plist >/dev/null 2>&1 || true
sudo launchctl bootout system/com.apple.smbd >/dev/null 2>&1 || true
sudo launchctl disable system/com.apple.smbd >/dev/null 2>&1 || true
sudo pkill -x smbd >/dev/null 2>&1 || true
sleep 2
echo "--- 445 after unload"; lsof -nP -i :445 || echo free

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if perl -e 'alarm 420; exec @ARGV' brew install samba > "$RT/brew.log" 2>&1; then
  SMB_PREFIX="$(brew --prefix samba)"
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
  sudo "$SMB_PREFIX/sbin/smbd" -D -s "$BASE/smb.conf" -p 445 >/dev/null 2>&1 || true
  sleep 5
  echo "--- 445 after smbd"; lsof -nP -i :445 || echo free
  pgrep -fl smbd || true
  tail -10 "$BASE/smb-run/log.smbd" 2>/dev/null || true
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
