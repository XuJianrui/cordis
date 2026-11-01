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
    status nfs-opts "$opts"
    echo "nfs=$BASE/nfsshare" > "$RT/remote.txt"
    mounted=1
    break
  fi
done
[ "$mounted" = 1 ] || status nfs fail-mount

# --- SMB via the built-in smbd: diagnostics, guest, then a real local user -----
mkdir -p "$BASE/smbshare" && chmod 777 "$BASE/smbshare"
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.smbd.plist >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist EnabledServices -array disk >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist AllowGuestAccess -bool true >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.smb.server.plist GuestAccess -bool true >/dev/null 2>&1 || true
sudo sharing -a "$BASE/smbshare" -S probe262 >/dev/null 2>&1 || true
sudo launchctl kickstart -k system/com.apple.smbd >/dev/null 2>&1 || true
sleep 3
{
  echo "--- launchctl"; sudo launchctl list | grep -i smbd || true
  echo "--- sharing"; sudo sharing -l || true
  echo "--- view guest"; sudo smbutil view -N //localhost || true
} > "$RT/smb-diag.txt" 2>&1 || true
# A real account gives mount_smbfs something to authenticate as.
sudo dscl . -passwd /Users/runner 'probe262pw' >/dev/null 2>&1 || true
mkdir -p "$BASE/smb"
smb_ok=0
for target in \
  "//guest@localhost/probe262" \
  "//runner:probe262pw@localhost/probe262" \
  "//localhost/probe262"; do
  if perl -e 'alarm 25; exec @ARGV' mount_smbfs -N "$target" "$BASE/smb" 2>>"$STATUS"; then
    add smb "$BASE/smb"
    status smb-target "$target"
    smb_ok=1
    break
  fi
done
if [ "$smb_ok" = 1 ]; then :; else
  # A dedicated local account is the last authentication path: guest is often
  # disabled and the runner account may have no SMB-usable password.
  sudo sysadminctl -addUser probe262 -password probe262pw -admin >/dev/null 2>&1 || true
  sudo dscl . -create /Users/probe262 >/dev/null 2>&1 || true
  sudo dscl . -passwd /Users/probe262 probe262pw >/dev/null 2>&1 || true
  sudo dscl . -create /Users/probe262 UniqueID 1001 >/dev/null 2>&1 || true
  sudo dscl . -create /Users/probe262 PrimaryGroupID 20 >/dev/null 2>&1 || true
  sudo dscl . -create /Users/probe262 UserShell /bin/bash >/dev/null 2>&1 || true
  sudo dscl . -create /Users/probe262 NFSHomeDirectory /Users/probe262 >/dev/null 2>&1 || true
  if perl -e 'alarm 25; exec @ARGV' mount_smbfs -N "//probe262:probe262pw@localhost/probe262" "$BASE/smb" 2>>"$STATUS"; then
    add smb "$BASE/smb"
    status smb-target "//probe262@localhost/probe262"
    smb_ok=1
  fi
fi
[ "$smb_ok" = 1 ] || status smb fail-mount

# --- WebDAV: a third network protocol, independent of smbd --------------------
mkdir -p "$BASE/davshare"
dav_pip=""
if perl -e 'alarm 180; exec @ARGV' python3 -m pip install --user --break-system-packages --quiet --disable-pip-version-check wsgidav cheroot >/dev/null 2>&1; then
  dav_pip="python3-user"
elif perl -e 'alarm 180; exec @ARGV' pip3 install --user --break-system-packages --quiet --disable-pip-version-check wsgidav cheroot >/dev/null 2>&1; then
  dav_pip="pip3-user"
fi
if [ -n "$dav_pip" ]; then
  status dav-pip "$dav_pip"
  (cd "$BASE/davshare" && nohup python3 -m wsgidav.server.server_cli --host 127.0.0.1 --port 8765 --root "$BASE/davshare" > "$RT/dav-server.log" 2>&1 &)
  sleep 3
  status dav-http "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/ 2>&1 || true)"
  mkdir -p "$BASE/dav"
  dav_ok=0
  for url in "http://127.0.0.1:8765/" "http://127.0.0.1:8765"; do
    if perl -e 'alarm 30; exec @ARGV' mount_webdav "$url" "$BASE/dav" 2>>"$STATUS"; then
      add dav "$BASE/dav"
      status dav-url "$url"
      dav_ok=1
      break
    fi
  done
  [ "$dav_ok" = 1 ] || status dav fail-mount
else
  status dav fail-pip
fi

echo "--- nfs diag"; cat "$RT/nfs-diag.txt" 2>/dev/null || true
echo "--- smb diag"; cat "$RT/smb-diag.txt" 2>/dev/null || true
echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
