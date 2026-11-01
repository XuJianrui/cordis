#!/usr/bin/env bash
# Probe 262: prepare non-default filesystem roots on ubuntu-latest.
# Every mount is best-effort: a failure is recorded in mount-status.txt, never hidden.
set -u
RT="${RUNNER_TEMP:-/tmp}"
ROOTS="$RT/roots.txt"; : > "$ROOTS"
STATUS="$RT/mount-status.txt"; : > "$STATUS"
BASE="$RT/probe262-roots"; mkdir -p "$BASE"

status() { echo "$1=$2" >> "$STATUS"; }
add() { echo "$1=$2" >> "$ROOTS"; status "$1" ok; }

mkdir -p "$BASE/local"
add local "$BASE/local"

sudo apt-get update -qq >/dev/null 2>&1 || true

# --- vfat loop device: case-insensitive, no inotify guarantees -----------------
if sudo apt-get install -y -qq dosfstools >/dev/null 2>&1; then
  dd if=/dev/zero of="$BASE/vfat.img" bs=1M count=64 status=none 2>/dev/null
  if mkfs.vfat "$BASE/vfat.img" >/dev/null 2>&1; then
    mkdir -p "$BASE/vfat"
    if sudo mount -o loop,umask=000 "$BASE/vfat.img" "$BASE/vfat" 2>>"$STATUS"; then
      add vfat "$BASE/vfat"
    else
      status vfat fail-mount
    fi
  else
    status vfat fail-mkfs
  fi
else
  status vfat fail-apt
fi

# --- sshfs: userspace network filesystem --------------------------------------
if sudo apt-get install -y -qq sshfs openssh-server >/dev/null 2>&1; then
  sudo service ssh start >/dev/null 2>&1 || sudo systemctl start ssh >/dev/null 2>&1 || true
  mkdir -p "$BASE/sshshare" && chmod 777 "$BASE/sshshare"
  ssh-keygen -q -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519" 2>/dev/null || true
  mkdir -p "$HOME/.ssh"
  cat "$HOME/.ssh/id_ed25519.pub" >> "$HOME/.ssh/authorized_keys" 2>/dev/null
  chmod 600 "$HOME/.ssh/authorized_keys" "$HOME/.ssh/id_ed25519" 2>/dev/null
  ssh-keyscan -H localhost >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
  mkdir -p "$BASE/sshfs"
  if sshfs -o idmap=user,StrictHostKeyChecking=no,reconnect "localhost:$BASE/sshshare" "$BASE/sshfs" 2>>"$STATUS"; then
    add sshfs "$BASE/sshfs"
  else
    status sshfs fail-mount
  fi
else
  status sshfs fail-apt
fi

# --- NFS: kernel client + local server ----------------------------------------
if sudo apt-get install -y -qq nfs-kernel-server nfs-common >/dev/null 2>&1; then
  mkdir -p "$BASE/nfsshare" && chmod 777 "$BASE/nfsshare"
  echo "$BASE/nfsshare *(rw,sync,no_subtree_check,no_root_squash,insecure)" | sudo tee -a /etc/exports >/dev/null
  sudo exportfs -ra >/dev/null 2>&1 || true
  sudo systemctl restart nfs-kernel-server >/dev/null 2>&1 || sudo service nfs-kernel-server restart >/dev/null 2>&1 || true
  mkdir -p "$BASE/nfs"
  if sudo mount -t nfs -o vers=4,addr=127.0.0.1 "localhost:$BASE/nfsshare" "$BASE/nfs" 2>>"$STATUS"; then
    add nfs "$BASE/nfs"
  else
    status nfs fail-mount
  fi
else
  status nfs fail-apt
fi

# --- overlayfs: container-style union mount -----------------------------------
mkdir -p "$BASE/ovl/lower" "$BASE/ovl/upper" "$BASE/ovl/work" "$BASE/ovl/merged"
if sudo mount -t overlay overlay \
  -o "lowerdir=$BASE/ovl/lower,upperdir=$BASE/ovl/upper,workdir=$BASE/ovl/work" \
  "$BASE/ovl/merged" 2>>"$STATUS"; then
  add overlay "$BASE/ovl/merged"
else
  status overlay fail-mount
fi

echo "--- roots"; cat "$ROOTS"
echo "--- status"; cat "$STATUS"
