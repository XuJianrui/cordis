#!/usr/bin/env bash
# Probe 262: prepare non-default filesystem roots on ubuntu-latest.
# Every mount is best-effort and bounded by `timeout`: a failure is recorded in
# mount-status.txt, never hidden.
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
BASE="$RT/probe262-roots"; mkdir -p "$BASE"

status() { echo "$1=$2" >> "$STATUS"; }
add() { echo "$1=$2" >> "$ROOTS"; status "$1" ok; }

mkdir -p "$BASE/local"
add local "$BASE/local"

timeout 300 sudo apt-get update -qq >/dev/null 2>&1 || true
timeout 300 sudo apt-get install -y -qq dosfstools sshfs openssh-server nfs-kernel-server nfs-common >/dev/null 2>&1 || true

# --- vfat loop device: case-insensitive, no inotify guarantees -----------------
dd if=/dev/zero of="$BASE/vfat.img" bs=1M count=64 status=none 2>/dev/null
if mkfs.vfat "$BASE/vfat.img" >/dev/null 2>&1; then
  mkdir -p "$BASE/vfat"
  if timeout 30 sudo mount -o loop,umask=000 "$BASE/vfat.img" "$BASE/vfat" 2>>"$STATUS"; then
    add vfat "$BASE/vfat"
  else
    status vfat fail-mount
  fi
else
  status vfat fail-mkfs
fi

# --- sshfs: userspace network filesystem --------------------------------------
timeout 30 sudo service ssh start >/dev/null 2>&1 || true
mkdir -p "$BASE/sshshare" && chmod 777 "$BASE/sshshare"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
ssh-keygen -q -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519" 2>/dev/null || true
cat "$HOME/.ssh/id_ed25519.pub" >> "$HOME/.ssh/authorized_keys" 2>/dev/null || true
chmod 600 "$HOME/.ssh/authorized_keys" "$HOME/.ssh/id_ed25519" 2>/dev/null || true
timeout 15 ssh-keyscan -H localhost >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
mkdir -p "$BASE/sshfs"
if timeout 60 sshfs -o idmap=user,StrictHostKeyChecking=no,BatchMode=yes,ConnectTimeout=5,ServerAliveInterval=5,reconnect \
  "localhost:$BASE/sshshare" "$BASE/sshfs" 2>>"$STATUS"; then
  add sshfs "$BASE/sshfs"
else
  status sshfs fail-mount
fi

# --- NFS: kernel client + local server ----------------------------------------
mkdir -p "$BASE/nfsshare" && chmod 777 "$BASE/nfsshare"
echo "$BASE/nfsshare *(rw,sync,no_subtree_check,no_root_squash,insecure)" | sudo tee -a /etc/exports >/dev/null
timeout 20 sudo exportfs -ra >/dev/null 2>&1 || true
timeout 45 sudo systemctl restart nfs-kernel-server >/dev/null 2>&1 || true
mkdir -p "$BASE/nfs"
if timeout 45 sudo mount -t nfs -o vers=4,addr=127.0.0.1,soft,timeo=50,retrans=1 \
  "localhost:$BASE/nfsshare" "$BASE/nfs" 2>>"$STATUS"; then
  add nfs "$BASE/nfs"
else
  status nfs fail-mount
fi

# --- overlayfs: container-style union mount -----------------------------------
mkdir -p "$BASE/ovl/lower" "$BASE/ovl/upper" "$BASE/ovl/work" "$BASE/ovl/merged"
if timeout 30 sudo mount -t overlay overlay \
  -o "lowerdir=$BASE/ovl/lower,upperdir=$BASE/ovl/upper,workdir=$BASE/ovl/work" \
  "$BASE/ovl/merged" 2>>"$STATUS"; then
  add overlay "$BASE/ovl/merged"
else
  status overlay fail-mount
fi

# Backing directories, used to simulate a write by another client.
: > "$RT/remote.txt"
[ -d "$BASE/sshshare" ] && echo "sshfs=$BASE/sshshare" >> "$RT/remote.txt"
[ -d "$BASE/nfsshare" ] && echo "nfs=$BASE/nfsshare" >> "$RT/remote.txt"

echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
