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

# --- SMB: Homebrew Samba first, then the built-in smbd -------------------------
smb_ok=0
mkdir -p "$BASE/smbshare" && chmod 777 "$BASE/smbshare"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v brew >/dev/null 2>&1; then
  if perl -e 'alarm 300; exec @ARGV' brew install samba > "$RT/brew-samba.log" 2>&1; then
    SMB_PREFIX="$(brew --prefix samba)"
    mkdir -p "$BASE/smb-run"
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
    sudo pkill -x smbd >/dev/null 2>&1 || true
    sleep 1
    sudo "$SMB_PREFIX/sbin/smbd" -D -s "$BASE/smb.conf" -p 445 >/dev/null 2>&1 || true
    sleep 5
    { pgrep -fl smbd || true; lsof -nP -i :445 || true; tail -8 "$BASE/smb-run/log.smbd" 2>/dev/null || true; } > "$RT/smb-brew-diag.txt" 2>&1 || true
    mkdir -p "$BASE/smb"
    if perl -e 'alarm 25; exec @ARGV' mount_smbfs -N "//guest@localhost/probe262" "$BASE/smb" 2>>"$STATUS"; then
      add smb "$BASE/smb"
      status smb-target "brew:guest@localhost"
      smb_ok=1
    else
      status smb-brew fail-mount
    fi
  else
    status smb-brew fail-install
  fi
else
  status smb-brew no-brew
fi

if [ "$smb_ok" = 0 ]; then
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
  sudo dscl . -passwd /Users/runner 'probe262pw' >/dev/null 2>&1 || true
  mkdir -p "$BASE/smb"
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
  if [ "$smb_ok" = 0 ]; then
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
fi
[ "$smb_ok" = 1 ] || status smb fail-mount

# --- SMB, third attempt: a userspace SMB2 server that needs no accounts --------
# `smbd` on the runner is unreachable by every authentication path (guest is
# refused, a local account is refused, and the Homebrew bottle ships no smbd),
# so the previous two attempts only ever proved "the daemon will not talk to
# this client". impacket's smbserver is a single Python process that speaks SMB2
# on 127.0.0.1 with no account database at all, which removes the auth question
# instead of answering it. If this mounts, the macOS-SMB cell stops being a
# scope boundary and becomes a reading.
if [ "$smb_ok" = 0 ]; then
  if perl -e 'alarm 240; exec @ARGV' python3 -m pip install --user --break-system-packages --quiet --disable-pip-version-check impacket >/dev/null 2>&1 \
    || perl -e 'alarm 240; exec @ARGV' pip3 install --user --break-system-packages --quiet --disable-pip-version-check impacket >/dev/null 2>&1; then
    status smb-impacket installed
    # impacket's CLI is positional: shareName sharePath. 445 needs root, and
    # -smb2support matters because current macOS refuses to negotiate SMB1.
    sudo env "PATH=$PATH" python3 -m impacket.smbserver probe262 "$BASE/smbshare" -smb2support -port 445 -debug > "$RT/impacket-smb.log" 2>&1 &
    IMP_PID=$!
    sleep 8
    status smb-impacket-port "$(nc -z 127.0.0.1 445 && echo open || echo closed)"
    status smb-impacket-log "$(tail -3 "$RT/impacket-smb.log" 2>/dev/null | tr '\n' ' ' | cut -c1-200)"
    mkdir -p "$BASE/smb5"
    # impacket answers any credential pair; guest with an empty password is the
    # form mount_smbfs can send without a keychain entry.
    for target in "//guest:@127.0.0.1/probe262" "//guest@127.0.0.1/probe262"; do
      if perl -e 'alarm 25; exec @ARGV' mount_smbfs -N "$target" "$BASE/smb5" 2>>"$STATUS"; then
        add smb-impacket "$BASE/smb5"
        status smb-impacket-target "$target"
        smb_ok=1
        break
      fi
    done
    [ "$smb_ok" = 1 ] || status smb-impacket fail-mount
    [ "$smb_ok" = 1 ] || sudo kill "$IMP_PID" 2>/dev/null || true
  else
    status smb-impacket fail-pip
  fi
fi

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
  (cd "$BASE/davshare" && nohup python3 -m wsgidav.server.server_cli --host 127.0.0.1 --port 8765 --root "$BASE/davshare" --auth anonymous > "$RT/dav-server.log" 2>&1 &)
  sleep 3
  status dav-http "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/ 2>&1 || true)"
  mkdir -p "$BASE/dav"
  dav_ok=0
  for spec in \
    "-S -v probe262|http://127.0.0.1:8765/" \
    "-S -v probe262|http://127.0.0.1:8765" \
    "|http://127.0.0.1:8765/"; do
    opts="${spec%%|*}"
    url="${spec#*|}"
    if perl -e 'alarm 30; exec @ARGV' mount_webdav $opts "$url" "$BASE/dav" 2>>"$STATUS"; then
      add dav "$BASE/dav"
      status dav-opts "$opts $url"
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
