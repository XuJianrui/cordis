#!/usr/bin/env bash
# D4: dm-flakey drops writes for 1s every 2s on the underlying loop device.
# A writer does atomic write -> fsync -> rename in a loop; it is SIGKILLed
# while writes are being dropped, then the target is read back. The target
# must be 'old' or 'new' -- never missing, never torn.
#
# Device-mapper requires an exclusive device: a loop device that is still
# mounted cannot be handed to a dm target ("reload ioctl ... Device or
# resource busy"). So the loop is never mounted directly -- only the mapper
# device is.
set -euo pipefail

IMG=$(mktemp /tmp/flakey-XXXX.img)
LOOP=""
MNT=""
cleanup() {
  [ -n "$MNT" ] && sudo umount "$MNT" 2>/dev/null || true
  [ -n "$MNT" ] && rmdir "$MNT" 2>/dev/null || true
  sudo dmsetup remove flakey262 2>/dev/null || true
  [ -n "$LOOP" ] && sudo losetup -d "$LOOP" 2>/dev/null || true
  rm -f "$IMG"
}
trap cleanup EXIT

dd if=/dev/zero of="$IMG" bs=1M count=64 status=none
LOOP=$(sudo losetup -f --show "$IMG")
SECT=$(sudo blockdev --getsz "$LOOP")

# Phase A -- a plain linear target, so the filesystem can be created and
# mounted without fighting the flakey down-interval.
echo "0 $SECT linear $LOOP 0" | sudo dmsetup create flakey262
sudo mkfs.ext4 -q -F /dev/mapper/flakey262
MNT=$(mktemp -d)
sudo mount /dev/mapper/flakey262 "$MNT"
sudo chmod 777 "$MNT"

# Phase B -- swap in the flakey target while the device is suspended.
# reload on a suspended device never races with I/O, so no EBUSY.
sudo dmsetup suspend flakey262
echo "0 $SECT flakey $LOOP 0 1 1 1 drop_writes" | sudo dmsetup reload flakey262
sudo dmsetup resume flakey262
echo "PROBE262_DM_STATUS $(sudo dmsetup status flakey262 | tr '\n' ' ')"

# Writer: the exact sequence the design promises is crash-consistent.
node - "$MNT" <<'NODE' &
const fs = require('node:fs')
const dir = process.argv[2]
const target = dir + '/target.txt'
const tmp = dir + '/tmp.txt'
fs.writeFileSync(target, 'old')
for (;;) {
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

# Kill in the middle of the flakey down-interval window, not after the loop.
sleep 6
sudo dmsetup status flakey262 | sed 's/^/PROBE262_DM_AT_KILL /'
kill -9 $PID 2>/dev/null || true
wait $PID 2>/dev/null || true

# Force the page cache out so the read below goes to the device, not to
# memory -- otherwise a dropped write would still read back as 'new'.
sync || true
echo 3 | sudo tee /proc/sys/vm/drop_caches > /dev/null

node - "$MNT" <<'NODE'
const fs = require('node:fs')
const dir = process.argv[2]
const target = dir + '/target.txt'
let content = ''
try { content = fs.readFileSync(target, 'utf8') } catch (e) { content = '<' + (e.code || 'ERR') + '>' }
const ok = content === 'old' || content === 'new'
console.log('PROBE262_CRASH ' + JSON.stringify({ content, ok }))
if (!ok) process.exit(3)
NODE

# Run the writer once more without drops, to prove the device still works
# and the 'old'/'new' reading above was not an artefact of a dead device.
sudo dmsetup suspend flakey262
echo "0 $SECT linear $LOOP 0" | sudo dmsetup reload flakey262
sudo dmsetup resume flakey262
node - "$MNT" <<'NODE'
const fs = require('node:fs')
const dir = process.argv[2]
const target = dir + '/target.txt'
fs.writeFileSync(target, 'control')
console.log('PROBE262_CRASH_CONTROL ' + JSON.stringify({ content: fs.readFileSync(target, 'utf8') }))
NODE
