#!/usr/bin/env bash
# D4: dm-flakey drops writes for 1s every 2s; a writer does atomic
# write -> fsync -> rename in a loop; the target must stay old or new.
set -euo pipefail
IMG=$(mktemp /tmp/flakey-XXXX.img)
dd if=/dev/zero of="$IMG" bs=1M count=64 status=none
LOOP=$(sudo losetup -f --show "$IMG")
sudo mkfs.ext4 -q "$LOOP"
MNT=$(mktemp -d); sudo mount "$LOOP" "$MNT"; sudo chmod 777 "$MNT"
SECT=$(sudo blockdev --getsz "$LOOP")
echo "0 $SECT flakey $LOOP 0 1 1 1 drop_writes" | sudo dmsetup create flakey262
sudo mkfs.ext4 -q /dev/mapper/flakey262
MNT2=$(mktemp -d); sudo mount /dev/mapper/flakey262 "$MNT2"; sudo chmod 777 "$MNT2"
node - "$MNT2" <<'NODE' &
const fs = require('node:fs')
const dir = process.argv[2]
const target = dir + '/target.txt'
const tmp = dir + '/tmp.txt'
fs.writeFileSync(target, 'old')
const end = Date.now() + 15000
while (Date.now() < end) {
  try {
    const fd = fs.openSync(tmp, 'w')
    fs.writeSync(fd, 'new')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fs.renameSync(tmp, target)
  } catch {}
}
NODE
PID=$!
sleep 18
kill $PID 2>/dev/null || true
node - "$MNT2" <<'NODE'
const fs = require('node:fs')
const dir = process.argv[2]
const target = dir + '/target.txt'
let content = ''
try { content = fs.readFileSync(target, 'utf8') } catch { content = '<missing>' }
console.log('PROBE262_CRASH ' + JSON.stringify({ content, ok: content === 'old' || content === 'new' }))
NODE
sudo umount "$MNT2" || true
sudo dmsetup remove flakey262 || true
sudo umount "$MNT" || true
sudo losetup -d "$LOOP" || true
rm -f "$IMG"
