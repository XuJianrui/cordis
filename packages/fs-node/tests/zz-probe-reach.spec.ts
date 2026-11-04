/* eslint-disable */
// Reachability probes for the three conditions the comment presently calls
// "out of reach" on GitHub runners. Each one is a claim about the runner that
// had not been tested against a working setup, so each is measured here.
//
//   1. macOS as an SMB *client*. The earlier attempt ran a userspace SMB2
//      server with no account database, so `Authentication error` was the
//      server rejecting an unknown account -- the client was never given a
//      chance. This one gives both sides the same credentials.
//
//   2. WSL2 paths on Windows. The earlier row asserted "no distribution, and
//      installing one needs a reboot" without printing what the image has.
//
//   3. A write path that stops accepting writes mid-flight. `drop_writes`
//      silently discards; `error_writes` is the other half and a different
//      kernel path -- writes fail while reads keep working, which is what
//      makes a read-back possible afterwards.
//
// These are instruments, not assertions about the product. Each test ends by
// asserting that its own markers were produced, so a step that silently does
// nothing cannot pass as a green run, and every platform prints an explicit
// skip marker instead of returning early from `it()`.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A synchronous sleep that does not depend on a `sleep` binary existing and
// does not busy-wait: both matter because the same spec runs on three systems.
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const log: string[] = []
function note(line: string) {
  log.push(line)
  console.log('REACH ' + line)
}

interface Result {
  status: number | null
  signal: string | null
  out: string
  /**
   * Why the spawn itself failed, when it did.
   *
   * Without this field, `status: null` plus an empty `out` means at least three
   * different things: the binary does not exist, the command was refused
   * before it ran, or it ran and printed nothing. `spawnSync` puts the reason
   * in `r.error` and the first version of this helper threw it away, so every
   * caller saw the same empty result and each one guessed differently.
   *
   * The same defect surfaced in the pnpm diagnostic as a six-millisecond
   * `status=null` with no output, which reads exactly like a fast success.
   */
  err: string
}

function run(cmd: string, args: string[], timeout = 120_000): Result {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout })
  return {
    status: r.status,
    signal: r.signal as string | null,
    out: ((r.stdout || '') + (r.stderr || '')).trim(),
    err: r.error ? String((r.error as NodeJS.ErrnoException).code || r.error.message) : '',
  }
}

function sh(script: string, timeout = 120_000): Result {
  const r = run('sh', ['-c', script], timeout)
  // A spawn that never happened must not look like a command that printed
  // nothing: every reading in this file is taken from `out`, so the failure
  // reason is put where those readings will show it. `EMPTY` and
  // `spawn-failed:ENOENT` are different findings and now print differently.
  if (r.err && !r.out) return { ...r, out: `spawn-failed:${r.err}` }
  return r
}

function oneLine(s: string, max = 400): string {
  // wsl.exe writes UTF-16LE, so its output arrives interleaved with NULs.
  return s.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// A step that dies early must not read as a green run: each test asserts the
// marker that can only be produced by reaching the end of its own procedure.
function reached(prefix: string): boolean {
  return log.some((l) => l.startsWith(prefix))
}

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
const isLinux = process.platform === 'linux'

describe('reach: can the runner provide the three conditions', () => {
  // ---------------------------------------------------------------------
  // 1. macOS as an SMB client, against a server that has an account.
  // ---------------------------------------------------------------------
  it('macos: mount an SMB share whose server knows the account', () => {
    if (!isMac) {
      note(`smb=skip platform=${process.platform}`)
      expect(log.length).toBeGreaterThan(0)
      return
    }

    // A venv, because the image marks its system Python as externally managed
    // and pip refuses to install into it (PEP 668). The venv also gives a
    // single path that sudo can see, so the server starts with the same
    // interpreter the packages were installed into.
    const venv = run('python3', ['-m', 'venv', '/tmp/smbenv'], 180_000)
    note(`smb-venv-exit=${venv.status}`)
    const py = '/tmp/smbenv/bin/python'
    const site = run(py, ['-c', 'import sysconfig;print(sysconfig.get_paths()["purelib"])'], 60_000)
    const userSite = site.out.split('\n').pop()!.trim()
    note(`smb-site=${userSite}`)

    const pip = run(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'impacket'], 300_000)
    note(`smb-pip-exit=${pip.status}`)
    if (pip.status !== 0) note('smb-pip-out=' + oneLine(pip.out, 300))

    const imported = run(py, ['-c', 'import impacket;print("ok")'])
    note(`smb-import=${imported.out.split('\n').pop()?.trim() || 'fail'}`)
    if (imported.out.trim() !== 'ok') {
      note('smb=unavailable reason=impacket-not-installed')
      expect(log.length).toBeGreaterThan(0)
      return
    }

    sh('rm -rf /tmp/smbshare /tmp/mnt && mkdir -p /tmp/smbshare/watch /tmp/mnt && echo hello > /tmp/smbshare/watch/a.txt')

    // The server must run as root to bind 445, and it must see the user-site
    // path, so PYTHONPATH is passed explicitly rather than relying on $HOME.
    // `-u` matters: stdout to a file is block-buffered, so an empty log is
    // otherwise ambiguous between "nothing arrived" and "8 KB not reached yet".
    const start = sh(
      `sudo -n env PYTHONPATH='${userSite}' /tmp/smbenv/bin/python -u /tmp/smbenv/bin/smbserver.py ` +
        `-smb2support -username smbuser -password 'Passw0rd1' -port 445 ` +
        `share /tmp/smbshare > /tmp/smbserver.log 2>&1 & echo started=$!`,
      60_000,
    )
    note('smb-server=' + oneLine(start.out, 120))
    // impacket ships console scripts under names that have moved between
    // releases; name the one this test invokes so a missing file is visible
    // here rather than as a bare `port=closed` further down.
    note('smb-server-bin=' + oneLine(sh('ls -l /tmp/smbenv/bin/smbserver.py 2>&1').out, 200))
    sh('sleep 8')

    const port = sh('nc -z 127.0.0.1 445 && echo open || echo closed')
    note(`smb-port=${port.out.trim()}`)

    const logTail = sh('tail -6 /tmp/smbserver.log || true')
    if (logTail.out) note('smb-server-log=' + oneLine(logTail.out, 400))

    // //user:password@host/share. One '@', not two: with '//u:p@@host/share'
    // the userinfo parses as 'u:p@' and the password carries a stray '@', so
    // the failure reads as a rejected account rather than as a malformed URL.
    //
    // No sudo: mount_smbfs is setuid root and mounts on behalf of the caller,
    // so the filesystem belongs to the runner. Under sudo it belongs to root,
    // and then `ls` and `fs.watch` answer EACCES -- which is a fact about who
    // mounted it, not about SMB.
    const mount = sh(
      `mount_smbfs '//smbuser:Passw0rd1@127.0.0.1/share' /tmp/mnt ` +
        `&& echo ok || echo fail-rc=$?`,
      90_000,
    )
    note(`smb-mount=${mount.out.trim()}`)
    note('smb-mounts=' + oneLine(sh('mount | grep -i smb || echo none').out, 200))
    note('smb-mount-owner=' + oneLine(sh("stat -f 'uid=%u mode=%Lp' /tmp/mnt 2>/dev/null || echo none").out, 80))
    // The rc alone says nothing about which side gave up, so ask the server
    // what it saw. A request that reached it and was refused reads differently
    // from a mount that never opened a connection.
    note('smb-server-log-after-mount=' + oneLine(sh('tail -20 /tmp/smbserver.log 2>/dev/null || true').out, 600))
    // `ifconfig lo` is the Linux name; macOS calls it lo0 and prints nothing
    // for `lo`, and because `head` succeeds the old `||` fallback never ran --
    // so an empty value here read as "no interface" when it was the wrong name.
    note('smb-net=' + oneLine(sh('ifconfig lo0 2>/dev/null | head -3; ifconfig lo 2>/dev/null | head -3').out, 200))
    note('smb-probe=' + oneLine(
      sh('smbutil statshares -a 2>&1 || true').out,
      300,
    ))

    const listed = sh('ls -la /tmp/mnt/watch 2>&1 || true')
    note('smb-listing=' + oneLine(listed.out, 300))

    const target = '/tmp/mnt/watch/a.txt'
    if (existsSync(target)) {
      // Both the watch and the write can throw on smbfs, and either one is a
      // reading: an ENOTSUP from `watch` and an EACCES from the write are
      // different answers about the mount, so neither may abort the test.
      const events: string[] = []
      let watcher: ReturnType<typeof watch> | null = null
      try {
        watcher = watch(target, (t, f) => events.push(`${t}:${f === null ? 'null' : String(f)}`))
      } catch (e: any) {
        note('smb-raw-watch-open=' + (e?.code || String(e).split('\n')[0]))
      }
      try {
        writeFileSync(target, 'x' + Date.now())
        note('smb-raw-write=ok')
      } catch (e: any) {
        note('smb-raw-write=' + (e?.code || String(e).split('\n')[0]))
      }
      const until = Date.now() + 2000
      while (Date.now() < until && events.length === 0) sleepSync(100)
      if (watcher) {
        watcher.close()
        note(`smb-raw-watch-events=${events.length} ${JSON.stringify(events.slice(0, 4))}`)
      }
    } else {
      note('smb-raw-watch=skipped reason=not-visible')
    }

    sh('umount /tmp/mnt 2>/dev/null || sudo -n umount /tmp/mnt 2>/dev/null || true')
    // The process command line is `python -u .../smbserver.py`, so the pattern
    // has to name the script; `-f impacket.smbserver` matched nothing and the
    // cleanup silently did nothing.
    sh(`sudo -n pkill -f 'smbserver.py' 2>/dev/null || true`)

    // Terminal marker: either the mount was attempted, or the probe recorded
    // why it could not be reached. Both are outcomes; silence is not.
    expect(reached('smb-mount=') || reached('smb=unavailable') || reached('smb=skip')).toBe(true)
  }, 600_000)

  // ---------------------------------------------------------------------
  // 2. WSL on the Windows image.
  // ---------------------------------------------------------------------
  it('windows: wsl state and \\\\wsl$ reachability', () => {
    if (!isWin) {
      note(`wsl=skip platform=${process.platform}`)
      expect(log.length).toBeGreaterThan(0)
      return
    }

    const status = run('wsl', ['--status'], 60_000)
    note(`wsl-status-exit=${status.status}`)
    note('wsl-status=' + oneLine(status.out, 400))

    const list = run('wsl', ['-l', '-v'], 60_000)
    note(`wsl-list-exit=${list.status}`)
    note('wsl-list=' + oneLine(list.out, 400))

    const dollar = run('powershell', ['-NoProfile', '-Command', "Test-Path '\\\\wsl$\\'"], 60_000)
    note(`wsl-dollar-exists=${dollar.out.trim() || 'no-output'}`)

    // Bounded install attempt: if the image needs a reboot this returns the
    // message rather than hanging the job.
    const install = run('wsl', ['--install', '--no-launch', '-d', 'Ubuntu'], 300_000)
    note(`wsl-install-exit=${install.status} signal=${install.signal ?? 'none'}`)
    note('wsl-install-out=' + oneLine(install.out, 500))

    const after = run('wsl', ['-l', '-v'], 60_000)
    note('wsl-list-after=' + oneLine(after.out, 400))
    const dollarAfter = run('powershell', ['-NoProfile', '-Command', "Test-Path '\\\\wsl$\\'"], 60_000)
    note(`wsl-dollar-after=${dollarAfter.out.trim() || 'no-output'}`)

    // A stopped distribution does not publish \\wsl$. Starting it is the step
    // the earlier row never reached, and it is what decides whether a path
    // under \\wsl$ exists at all.
    const boot = run(
      'wsl',
      ['-d', 'Ubuntu', '-u', 'root', '--', 'sh', '-c', 'mkdir -p /tmp/reach && echo hello > /tmp/reach/a.txt && echo booted'],
      180_000,
    )
    note(`wsl-boot-exit=${boot.status}`)
    note('wsl-boot-out=' + oneLine(boot.out, 200))

    const running = run('powershell', ['-NoProfile', '-Command', "Test-Path '\\\\wsl$\\'"], 60_000)
    note(`wsl-dollar-running=${running.out.trim() || 'no-output'}`)

    const children = run(
      'powershell',
      ['-NoProfile', '-Command', "Get-ChildItem '\\\\wsl$\\' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }"],
      60_000,
    )
    note('wsl-dollar-children=' + oneLine(children.out, 200))

    const remote = '\\\\wsl$\\Ubuntu\\tmp\\reach\\a.txt'
    const visible = run('powershell', ['-NoProfile', '-Command', `Test-Path '${remote}'`], 60_000)
    note(`wsl-file-exists=${visible.out.trim() || 'no-output'}`)

    if (visible.out.trim().toLowerCase() === 'true') {
      const events: string[] = []
      // The first run threw EISDIR here, which is the answer rather than a
      // defect in the probe: the path resolves, but libuv will not treat it as
      // a watchable file. Record both the file watch and the directory watch
      // so the failure mode is stated rather than inferred.
      try {
        const w = watch(remote, (t, f) => events.push(`${t}:${f === null ? 'null' : String(f)}`))
        try {
          writeFileSync(remote, 'from-windows-' + Date.now())
        } catch (e: any) {
          note('wsl-write=' + (e?.code || String(e)))
        }
        const until = Date.now() + 3000
        while (Date.now() < until && events.length === 0) sleepSync(100)
        w.close()
        note(`wsl-file-watch=ok events=${events.length} ${JSON.stringify(events.slice(0, 4))}`)
      } catch (e: any) {
        note('wsl-file-watch=' + (e?.code || String(e).split('\n')[0]))
      }

      try {
        const dirEvents: string[] = []
        const dw = watch('\\\\wsl$\\Ubuntu\\tmp\\reach', (t, f) =>
          dirEvents.push(`${t}:${f === null ? 'null' : String(f)}`),
        )
        try {
          writeFileSync('\\\\wsl$\\Ubuntu\\tmp\\reach\\b.txt', 'x' + Date.now())
        } catch (e: any) {
          note('wsl-dirwrite=' + (e?.code || String(e)))
        }
        const until = Date.now() + 3000
        while (Date.now() < until && dirEvents.length === 0) sleepSync(100)
        dw.close()
        note(`wsl-dir-watch=ok events=${dirEvents.length}`)
      } catch (e: any) {
        note('wsl-dir-watch=' + (e?.code || String(e).split('\n')[0]))
      }
    } else {
      note('wsl-raw-watch=skipped reason=file-not-visible')
    }

    expect(reached('wsl-dollar-running=')).toBe(true)
  }, 600_000)

  // ---------------------------------------------------------------------
  // 3. A device that stops accepting writes while still serving reads.
  // ---------------------------------------------------------------------
  it('linux: dm-flakey error_writes keeps reads and refuses writes', () => {
    if (!isLinux) {
      note(`write-refusal=skip platform=${process.platform}`)
      expect(log.length).toBeGreaterThan(0)
      return
    }

    const mod = run('sudo', ['-n', 'modprobe', 'dm-flakey'], 60_000)
    note(`wr-modprobe-exit=${mod.status}`)
    const targets = run('sudo', ['-n', 'dmsetup', 'targets'], 60_000)
    note(`wr-flakey-present=${/flakey/i.test(targets.out) ? 'yes' : 'no'}`)
    if (!/flakey/i.test(targets.out)) {
      note('write-refusal=unavailable reason=no-dm-flakey')
      expect(log.length).toBeGreaterThan(0)
      return
    }

    sh('rm -f /tmp/disk.img && truncate -s 64M /tmp/disk.img')
    const loop = sh("sudo -n losetup --find --show /tmp/disk.img")
    const dev = loop.out.trim()
    note(`wr-loop=${dev || 'none'}`)
    if (!dev) {
      note('write-refusal=unavailable reason=no-loop-device')
      expect(log.length).toBeGreaterThan(0)
      return
    }

    const sectors = run('sudo', ['-n', 'blockdev', '--getsz', dev], 60_000).out.trim()
    note(`wr-sectors=${sectors}`)

    // Healthy for 20 s so mkfs and mount happen inside the window, then 600 s
    // of error_writes: every write returns EIO, reads keep working.
    const table = sh(`echo "0 ${sectors} flakey ${dev} 0 20 600 1 error_writes" | sudo -n dmsetup create cut`)
    note(`wr-create-exit=${table.status} ${oneLine(table.out, 200)}`)

    const mkfs = sh('sudo -n mkfs.ext4 -q /dev/mapper/cut && echo ok || echo fail')
    note(`wr-mkfs=${mkfs.out.trim()}`)
    const mount = sh('sudo -n mkdir -p /mnt/cut && sudo -n mount /dev/mapper/cut /mnt/cut && echo ok || echo fail')
    note(`wr-mount=${mount.out.trim()}`)

    // The fresh ext4 root belongs to root; the test process does not. Without
    // this the first write fails EACCES and the probe measures the wrong thing.
    const chown = sh('sudo -n chown "$(id -u):$(id -g)" /mnt/cut && echo ok || echo fail')
    note(`wr-chown=${chown.out.trim()}`)

    // Write until the device starts refusing, then read the same path back.
    let firstError = ''
    let writes = 0
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      try {
        writeFileSync('/mnt/cut/target.txt', 'v' + writes)
        writes++
      } catch (e: any) {
        firstError = e?.code || String(e)
        break
      }
      sleepSync(50)
    }
    note(`wr-writes=${writes} first-error=${firstError || 'none-within-45s'}`)

    let readBack = 'missing'
    try {
      readBack = readFileSync('/mnt/cut/target.txt', 'utf8')
    } catch (e: any) {
      readBack = 'read-error:' + (e?.code || String(e))
    }
    note(`wr-read-after-error=${oneLine(readBack, 80)}`)

    sh('sudo -n umount /mnt/cut 2>/dev/null || true')
    sh('sudo -n dmsetup remove cut 2>/dev/null || true')
    sh(`sudo -n losetup -d ${dev} 2>/dev/null || true`)

    // Terminal marker: the read-back is the point of the probe, so it must
    // have been attempted even when every write was refused.
    expect(reached('wr-read-after-error=')).toBe(true)
  }, 600_000)

  // ---------------------------------------------------------------------
  // 3b. Three links in the chain that this comment used to call out of reach,
  //     and that the kernel provides a mechanism for. All three are produced
  //     by the block layer itself, not stood in for by a stub.
  //
  // The chain a write travels: page cache -> writeback -> block layer ->
  // device cache -> medium. The arms above cover the first hop (killing the
  // guest loses what it had not written down) and the last (a guest that
  // synced keeps its values when the emulator is killed). These three cover
  // what happens *inside* the block layer and below it.
  //
  // **A torn write.** `dm-flakey` has a feature beyond the three
  // discard/error modes: `corrupt_bio_byte <Nth> <direction> <value>
  // <flags>` replaces a chosen byte of a matching bio during the down
  // interval. The bio is accepted -- not failed, not dropped -- so the caller
  // is told the write succeeded while the medium receives different bytes.
  // That is the shape a power cut leaves behind, and the block layer makes it.
  //
  // Two details cost a CI run to learn, both worth recording:
  //   * it counts as *five* feature arguments in `#feature args`, not one:
  //     the keyword plus four parameters. `1 corrupt_bio_byte ...` is rejected
  //     outright with `Invalid argument`, which reads like an unsupported
  //     feature and is actually an arithmetic mistake.
  //   * it only fires during the *down* interval, so `up` must be 0 for the
  //     device to be unreliable from the moment it is created.
  //
  // **A device whose write cache lies.** `drop_writes` is the mechanism, not
  // QEMU's `cache=unsafe`. The difference matters:
  //   * `drop_writes` does `bio_endio(bio)` and returns `DM_MAPIO_SUBMITTED`:
  //     the write completes successfully and the data goes nowhere. A guest
  //     that syncs is told the bytes are durable and they are not.
  //   * `cache=unsafe` only sets `cache.no-flush`, which declines to flush the
  //     *host's* page cache. Killing the emulator leaves those pages in the
  //     host kernel, which still writes them back -- so that arm measured a
  //     property this setup cannot exhibit, and read `survived` for a reason
  //     that had nothing to do with the lie. Measured, then discarded.
  //
  // **In-flight DMA.** `dm-delay` holds a write for a chosen number of
  // milliseconds before passing it down. A write that has been issued and not
  // yet landed, with the machine going away underneath it, is the in-flight
  // window itself rather than an analogue of it. The read-back then says
  // whether a write still in the delay queue survives -- which is what the
  // question "does an in-flight transfer survive" reduces to at this layer.
  // ---------------------------------------------------------------------
  it('linux: a torn write and a cache that acknowledges but does not persist', () => {
    if (!isLinux) {
      note(`torn=skip platform=${process.platform}`)
      expect(log.length).toBeGreaterThan(0)
      return
    }

    const mod = run('sudo', ['-n', 'modprobe', 'dm-flakey'], 60_000)
    note(`torn-modprobe-exit=${mod.status}`)
    const targets = run('sudo', ['-n', 'dmsetup', 'targets'], 60_000)
    if (!/flakey/i.test(targets.out)) {
      note('torn=unavailable reason=no-dm-flakey')
      expect(log.length).toBeGreaterThan(0)
      return
    }

    sh('rm -f /tmp/torn.img && truncate -s 64M /tmp/torn.img')
    const loop = sh("sudo -n losetup --find --show /tmp/torn.img")
    const dev = loop.out.trim()
    note(`torn-loop=${dev || 'none'}`)
    if (!dev) {
      note('torn=unavailable reason=no-loop-device')
      expect(log.length).toBeGreaterThan(0)
      return
    }
    const sectors = run('sudo', ['-n', 'blockdev', '--getsz', dev], 60_000).out.trim()
    note(`torn-sectors=${sectors}`)

    // A control pass first, with no feature argument at all, so a difference
    // later cannot be attributed to the harness. `<dev> <offset> <up> <down>`
    // with a descending interval pair keeps the device up for a long time and
    // then down for one second; with no features the down state fails all
    // I/O, which the control never reaches.
    const plain = sh(`echo "0 ${sectors} flakey ${dev} 0 3600 1" | sudo -n dmsetup create tornplain`)
    note(`torn-control-create=${plain.status} ${oneLine(plain.out, 120)}`)
    if (plain.status !== 0) {
      note('torn=unavailable reason=control-table-rejected')
      sh(`sudo -n losetup -d ${dev} 2>/dev/null || true`)
      expect(reached('torn-control-create=')).toBe(true)
      return
    }

    // Write straight to the block device, not through a filesystem.
    //
    // The first version of this measured through ext4, which was wrong for a
    // reason worth writing down: `corrupt_bio_byte` rewrites a byte of every
    // matching bio, and a filesystem's writes are mostly metadata, so the
    // block that changed was not the one carrying the payload. Writing to the
    // raw device makes the bio and the payload the same object, so the
    // reading is about the write path rather than about which block ext4
    // happened to place first.
    //
    // A 1024-byte pattern whose every byte is known, written at a 1 MiB
    // offset so it does not collide with anything else on the device.
    const pattern = 'TORNMARKER' + '0123456789'.repeat(101)
    const payload = `/tmp/torn-payload`
    sh(`printf '%s' '${pattern}' > ${payload}`)
    const seek = 1024  // KiB
    note(`torn-payload-bytes=${sh(`wc -c < ${payload}`).out.trim()}`)
    note(`torn-seek-kib=${seek}`)

    const ctlWrite = sh(`sudo -n dd if=${payload} of=/dev/mapper/tornplain bs=1024 seek=${seek} conv=fsync 2>&1 | tail -1`)
    note(`torn-control-dd=${oneLine(ctlWrite.out, 120)}`)
    // Read the payload back twice: once through the mapper, once from the loop
    // device underneath. The two fail differently, and the earlier `EMPTY` --
    // on the run whose control table was `up=1 down=1`, so the read landed in
    // the down interval where a feature-less flakey device fails all I/O --
    // printed a single line that could have meant either. Keeping both makes
    // "the mapper accepted the write" and "the medium holds it" separate
    // statements rather than one.
    sh('sync')
    const ctlViaMapper = sh(
      `sudo -n dd if=/dev/mapper/tornplain bs=1024 skip=${seek} count=1 status=none | tr -d '\\0' | head -c 40`,
    )
    note(`torn-control-via-mapper=${oneLine(ctlViaMapper.out, 40) || 'EMPTY'}`)
    // The reading from the medium is taken *after* the mapper is removed, and
    // the order is the whole point. ubuntu-24 printed
    // `torn-control-readback=EMPTY` with `dd` reporting `1+0 records in 1+0
    // records out`, which is a full block of zeroes rather than a failed read,
    // while a one-byte read at the same offset after `dmsetup remove` returned
    // 84 ('T'). Same offset, same device, different answer -- the only
    // difference was the teardown. The write was still in the loop device's
    // page cache, and removing the mapper is what pushed it to the backing
    // file. So `sync` before a teardown is not the same as `sync` after one,
    // and a "medium" read taken while the mapper is up is a cache read wearing
    // a medium's name.
    sh('sudo -n dmsetup remove tornplain 2>/dev/null; echo "remove-rc=$?" >> /tmp/torn-ctl.err')
    sh('sync')
    // The exit status is recorded because an empty read and a refused read are
    // different findings and the first version printed both as `EMPTY`. The
    // previous run's `EMPTY` had a third cause again -- a control table of
    // `up=1 down=1`, whose down interval a feature-less flakey device fails all
    // I/O in.
    const ctlBack = sh(
      `sudo -n dd if=${dev} bs=1024 skip=${seek} count=1 2>>/tmp/torn-ctl.err | tr -d '\\0' | head -c 40; ` +
        'echo "|dd-rc=$?"',
    )
    note(`torn-control-readback=${oneLine(ctlBack.out, 60) || 'EMPTY'}`)
    note(`torn-control-dd-err=${oneLine(sh('cat /tmp/torn-ctl.err 2>/dev/null || true').out, 120) || 'none'}`)
    // The reading is taken from the leading token, before the appended
    // `|dd-rc=` marker, so `torn-control-payload=` is the payload and nothing
    // else. `/^TORNMARKER/` on the whole line happened to work as well --
    // `head -c 40` runs before the `echo`, so the marker never displaced a
    // byte of the payload -- but a reading whose answer depends on that
    // ordering is one edit away from being wrong for a reason nobody sees.
    const ctlPayload = ctlBack.out.split('|')[0]
    note(`torn-control-payload=${oneLine(ctlPayload, 40) || 'EMPTY'}`)
    note(`torn-control-match=${/^TORNMARKER/.test(ctlPayload) ? 'yes' : 'no'}`)

    // Now the same write with the first byte of every write bio replaced.
    // The bio is still accepted -- not failed, not dropped -- so the caller is
    // told the write succeeded while the medium receives different bytes.
    //
    // `up=0 down=3600`: corrupt_bio_byte only fires during the down interval,
    // so the device has to start there. `5` and not `1`: the keyword plus its
    // four parameters occupy five slots in `#feature args`. Both numbers were
    // wrong on the first attempt, and the kernel's answer -- `Invalid
    // argument` -- said nothing about which of the two it disliked.
    const corrupt = sh(
      `echo "0 ${sectors} flakey ${dev} 0 0 3600 5 corrupt_bio_byte 1 w 88 0" | sudo -n dmsetup create torn`,
    )
    note(`torn-create=${corrupt.status} ${oneLine(corrupt.out, 160)}`)
    if (corrupt.status !== 0) {
      note('torn=unavailable reason=corrupt_bio_byte-not-accepted')
      sh('sudo -n dmsetup remove torn 2>/dev/null || true')
      sh(`sudo -n losetup -d ${dev} 2>/dev/null || true`)
      expect(reached('torn-create=')).toBe(true)
      return
    }
    // What the kernel thinks it loaded, read back from the driver rather than
    // assumed: `dmsetup table` prints the normalised feature count, so a table
    // that was silently reinterpreted is visible here.
    note('torn-table=' + oneLine(sh('sudo -n dmsetup table torn 2>&1 || true').out, 200))

    // The same payload at a different offset, so the two readings cannot be
    // confused: the control's copy stays where it was.
    const tornSeek = seek + 1024
    const tornWrite = sh(`sudo -n dd if=${payload} of=/dev/mapper/torn bs=1024 seek=${tornSeek} conv=fsync 2>&1 | tail -1`)
    note(`torn-dd=${oneLine(tornWrite.out, 120)}`)
    // Removed before the medium is read, for the reason recorded at the control
    // above: with the mapper still up the write can sit in the loop device's
    // page cache and a read from `${dev}` returns zeroes that look like "the
    // write never landed". The control arm on ubuntu-24 read `EMPTY` that way
    // while the same offset read 84 after teardown. This arm happened to read
    // correctly with the mapper up, which is a reason to fix the order rather
    // than a reason to leave it.
    sh('sudo -n dmsetup remove torn 2>/dev/null; echo "torn-remove-rc=$?" >> /tmp/torn-ctl.err')
    sh('sync')
    // `dd` reported success. What the medium holds:
    const tornBack = sh(`sudo -n dd if=${dev} bs=1024 skip=${tornSeek} count=1 2>/dev/null | tr -d '\\0' | head -c 40`)
    note(`torn-readback=${oneLine(tornBack.out, 60) || 'EMPTY'}`)
    note(`torn-match=${tornBack.out.startsWith('TORNMARKER') ? 'yes' : 'no'}`)
    // The byte that was replaced, read on its own so the reading names the
    // mechanism instead of only reporting a mismatch.
    const firstByte = sh(`sudo -n dd if=${dev} bs=1 skip=$(( ${tornSeek} * 1024 )) count=1 2>/dev/null | od -An -tu1`)
    note(`torn-first-byte=${oneLine(firstByte.out, 20) || 'none'}`)
    const ctlFirstByte = sh(`sudo -n dd if=${dev} bs=1 skip=$(( ${seek} * 1024 )) count=1 2>/dev/null | od -An -tu1`)
    note(`torn-control-first-byte=${oneLine(ctlFirstByte.out, 20) || 'none'}`)
    // 84 = 'T'. The corrupted write should hold 88 = 'X' at the same place,
    // with the rest of the payload intact -- a write that landed and differs
    // by exactly the byte the block layer was told to change.
    note(`torn-accepted-and-altered=${/^\s*88\s*$/.test(firstByte.out) ? 'yes' : 'no'}`)
    note(`torn-control-intact=${/^\s*84\s*$/.test(ctlFirstByte.out) ? 'yes' : 'no'}`)

    sh(`sudo -n losetup -d ${dev} 2>/dev/null || true`)

    // The claim under test is the pair of numbers, not the fact that the
    // numbers were printed. `reached()` only asks whether the line exists, so
    // `torn-control-match=no` would satisfy it just as well as `yes` -- which
    // is the defect this comment has just been recording as a rule. The
    // assertions below read the values.
    expect(
      log.find((l) => l.startsWith('torn-control-intact=')),
      'the control write must read back its own first byte',
    ).toBe('torn-control-intact=yes')
    expect(
      log.find((l) => l.startsWith('torn-accepted-and-altered=')),
      'the corrupted write must land with the replaced byte',
    ).toBe('torn-accepted-and-altered=yes')
    expect(
      log.find((l) => l.startsWith('torn-control-match=')),
      'the control payload must read back intact',
    ).toBe('torn-control-match=yes')
  }, 600_000)

  // ---------------------------------------------------------------------
  // 3c. In-flight DMA: a write that has been issued and has not landed.
  //
  // This was the third item this comment called out of reach, and the one the
  // others were blamed on unfairly. `dm-delay` holds an I/O request for a
  // chosen number of milliseconds before passing it down, so a write can be
  // made to spend a controllable window in flight. Ending the machine inside
  // that window is the in-flight case itself, not a stand-in for it: at the
  // moment the power goes, the transfer is queued and the medium has not seen
  // it.
  //
  // The reading is deliberately a pair. Both devices get the same write and
  // the same cut; the only difference is whether a delay was in the path. The
  // undelayed one must be on the medium and the delayed one must not, which is
  // what makes "the write was in flight" a measured statement rather than an
  // assumed one. A delay that turns out not to lose the write says the window
  // was too short or the queue was already drained -- also a finding, reported
  // as such.
  // ---------------------------------------------------------------------
  it('linux: a write held in flight by dm-delay does not reach the medium', () => {
    if (!isLinux) {
      note(`inflight=skip platform=${process.platform}`)
      expect(log.length).toBeGreaterThan(0)
      return
    }

    run('sudo', ['-n', 'modprobe', 'dm-delay'], 60_000)
    const targets = run('sudo', ['-n', 'dmsetup', 'targets'], 60_000)
    note(`inflight-delay-present=${/delay/i.test(targets.out) ? 'yes' : 'no'}`)
    if (!/delay/i.test(targets.out)) {
      note('inflight=unavailable reason=no-dm-delay')
      expect(reached('inflight-delay-present=')).toBe(true)
      return
    }

    // Two independent images, so the two readings cannot share a page cache
    // entry or a loop device, and the control cannot be explained by the
    // experiment's leftovers.
    const mkImage = (path: string) => {
      // `truncate` under sudo as well: the first version ran `rm` under sudo
      // and `truncate` without it, which works exactly once and then fails on
      // a root-owned file -- the same asymmetry that made the torn arm read
      // `EMPTY` above.
      sh(`sudo -n rm -f ${path} && sudo -n truncate -s 32M ${path} && sudo -n mkfs.ext4 -q ${path}`)
      return sh(`sudo -n losetup --find --show ${path}`).out.trim()
    }
    const ctlDev = mkImage('/tmp/inflight-ctl.img')
    const expDev = mkImage('/tmp/inflight-exp.img')
    note(`inflight-control-loop=${ctlDev || 'none'}`)
    note(`inflight-expect-loop=${expDev || 'none'}`)
    if (!ctlDev || !expDev) {
      note('inflight=unavailable reason=no-loop-device')
      expect(reached('inflight-control-loop=')).toBe(true)
      return
    }
    const ctlSectors = run('sudo', ['-n', 'blockdev', '--getsz', ctlDev], 60_000).out.trim()
    const expSectors = run('sudo', ['-n', 'blockdev', '--getsz', expDev], 60_000).out.trim()
    note(`inflight-sectors=${ctlSectors}/${expSectors}`)

    // The delayed device holds writes for 30 s -- far longer than the window
    // this test is willing to wait -- so a write issued just before the cut is
    // still in the queue when the cut happens. Reads go through undelayed, so
    // the read path stays usable and a failure to read is not mistaken for a
    // lost write.
    //
    // Table shape, from the kernel's dm-delay documentation:
    //   <device> <offset> <read_delay> [<write_device> <write_offset>
    //   <write_delay> [<flush_device> <flush_offset> <flush_delay>]]
    // Nine arguments here so writes and flushes are delayed separately from
    // reads; zero delay on reads keeps the measurement one-directional.
    const expTable = sh(
      `echo "0 ${expSectors} delay ${expDev} 0 0 ${expDev} 0 30000 ${expDev} 0 30000" | sudo -n dmsetup create slow`,
    )
    note(`inflight-delay-create=${expTable.status} ${oneLine(expTable.out, 160)}`)
    note('inflight-delay-table=' + oneLine(sh('sudo -n dmsetup table slow 2>&1 || true').out, 200))
    if (expTable.status !== 0) {
      sh(`sudo -n losetup -d ${ctlDev} 2>/dev/null || true`)
      sh(`sudo -n losetup -d ${expDev} 2>/dev/null || true`)
      note('inflight=unavailable reason=delay-table-rejected')
      expect(reached('inflight-delay-create=')).toBe(true)
      return
    }

    // Seed a non-zero byte at the offset both writes will target. Without
    // this the experiment cannot tell its two outcomes apart: the payload is
    // `/dev/zero`, so "the write landed" and "nothing was ever written" both
    // read as zero. With a 0x5a at that offset first, zero afterwards means
    // the write arrived and 0x5a means it did not.
    for (const d of [ctlDev, expDev]) {
      sh(`printf '\\132' | sudo -n dd of=${d} bs=1 seek=$(( 8 * 1048576 )) count=1 conv=fsync 2>/dev/null`)
    }
    const seedCtl = sh(`sudo -n dd if=${ctlDev} bs=1 skip=$(( 8 * 1048576 )) count=1 2>/dev/null | od -An -tu1`)
    const seedExp = sh(`sudo -n dd if=${expDev} bs=1 skip=$(( 8 * 1048576 )) count=1 2>/dev/null | od -An -tu1`)
    note(`inflight-control-seed=${oneLine(seedCtl.out, 20) || 'none'}`)
    note(`inflight-expect-seed=${oneLine(seedExp.out, 20) || 'none'}`)
    // 90 = 0x5a. If the seed did not take, both readings below are answering
    // about a zero byte that was already there and the comparison is void.
    const seeded = /^\s*90\s*$/.test(seedCtl.out) && /^\s*90\s*$/.test(seedExp.out)
    note(`inflight-seeded=${seeded ? 'yes' : 'no'}`)
    if (!seeded) {
      sh('sudo -n dmsetup remove slow 2>/dev/null || true')
      sh(`sudo -n losetup -d ${ctlDev} 2>/dev/null || true`)
      sh(`sudo -n losetup -d ${expDev} 2>/dev/null || true`)
      note('inflight=unavailable reason=seed-byte-not-written')
      expect(reached('inflight-seeded=')).toBe(true)
      return
    }

    // The payload is a whole 1 MiB block of zeroes, written with O_DIRECT on
    // both sides. Without it the write lands in the page cache and `dd`
    // returns before the block layer has seen anything, so the delayed arm
    // would be cutting a write that had not been issued yet -- and it would
    // read `did not land` for a reason that has nothing to do with the delay.
    const ctlWrite = sh(
      `sudo -n dd if=/dev/zero of=${ctlDev} bs=1M count=1 seek=8 oflag=direct conv=fsync 2>&1 | tail -1`,
    )
    note(`inflight-control-dd=${oneLine(ctlWrite.out, 100)}`)

    // The delayed write has to be *in flight* when the cut happens, and that
    // rules out waiting for `dd`: with `oflag=direct` the write is synchronous,
    // so `dd` returns only after the 30 s delay has elapsed. The previous run
    // measured exactly that -- `inflight-delay-dd-ms=60601` and a verdict of
    // `both-landed-window-too-short`. The delay was not too short; the probe
    // waited it out and then cut a write that had already landed.
    //
    // So the write is started in the background and the cut happens while it
    // is still in the queue. Nothing waits on it, which is what "in flight"
    // means. The background process is deliberately not `&`-detached from the
    // test: it is owned by this shell, and the marker records whether it was
    // still running when the cut was issued.
    const expBg = sh(
      `sudo -n sh -c 'nohup dd if=/dev/zero of=/dev/mapper/slow bs=1M count=1 seek=8 oflag=direct ` +
        `>/tmp/inflight-dd.out 2>&1 & echo "bg-pid=$!"; sleep 0.2' 2>&1`,
    )
    note(`inflight-delay-bg=${oneLine(expBg.out, 120)}`)
    // A short settle so the bio is actually queued rather than merely
    // scheduled. Without it the cut can win the race against the write being
    // issued, which would look like a lost write for the wrong reason.
    sleepSync(1_500)
    // Checked against the pid this probe started, not against `pgrep dd`: the
    // same job runs other workers and any of them can have a `dd` open, so a
    // count of the name would not be a statement about this write.
    const bgPid = /bg-pid=(\d+)/.exec(expBg.out)?.[1] ?? ''
    note(`inflight-delay-dd-pid=${bgPid || 'none'}`)
    let ddState = 'unknown'
    if (bgPid) {
      const alive = sh(`if [ -d /proc/${bgPid} ]; then echo running; else echo gone; fi`)
      ddState = alive.out.trim() || 'unknown'
    }
    note(`inflight-delay-dd-state=${ddState}`)

    // The cut: tear the mapper down while the write is still queued, which
    // discards whatever dm-delay was holding. This is the closest a process
    // can get to "the machine went away with the transfer outstanding" -- the
    // request exists in the queue and the medium never sees it.
    //
    // `--force` is load-bearing. Without it, `dmsetup remove` waits for the
    // outstanding I/O to drain, which is the opposite of this arm: the delay
    // would elapse, the write would land, and the reading would say the queue
    // survives being torn down. Plain `remove` also refuses on a device with
    // queued I/O on some kernels, which would report a failed cut rather than
    // a cut.
    // No `|| true` here: it would make `status` zero whether the removal
    // worked or not, and the two lines below are read differently depending on
    // which happened.
    const removed = sh('sudo -n timeout 60 dmsetup remove --force slow 2>&1')
    note(`inflight-remove=${removed.status} ${oneLine(removed.out, 160) || 'quiet'}`)
    // Whether a mapper is still present decides how to read the next two
    // lines: with the device gone, the write's destination no longer exists;
    // with it still present, the write is simply late and the arm measured
    // nothing.
    const infoOut = sh('sudo -n dmsetup info slow 2>&1')
    note(`inflight-mapper-info-rc=${infoOut.status}`)
    note(`inflight-mapper-gone=${infoOut.status === 0 ? 'no' : 'yes'}`)

    // Both reads come from the loop devices underneath, past any mapper, and
    // after dropping the host page cache so a value cannot be served from the
    // same cache the cut would have taken with it.
    sh(
      'sync; if sudo -n sh -c "echo 3 > /proc/sys/vm/drop_caches" 2>/dev/null; then echo dropped; ' +
        'elif sh -c "echo 3 > /proc/sys/vm/drop_caches" 2>/dev/null; then echo dropped; else echo refused; fi',
      120_000,
    )
    // No `|| true` on the read-back and no `2>/dev/null` swallowing its
    // status: a failed read and a zero byte are different findings, and the
    // verdict below turns on which one happened.
    //
    // `${PIPESTATUS[0]}` was wrong twice over. It is a bash array, and `sh` on
    // ubuntu-24 is dash, which answered `sh: 1: Bad substitution` and wrote
    // that string where the number should be -- so `rc=` read `missing` on
    // both arms and the verdict could only ever be
    // `read-back-failed-no-reading`. The bytes themselves were in the same
    // output and were correct (`0` and `90`), which is the shape this whole
    // file is about: a parse failing to the left of a reading that had
    // already arrived.
    //
    // A temp file is used instead of a pipe status, so the construct works in
    // any POSIX shell: `dd` writes the byte, its exit status goes to a file,
    // and `od` reads the byte back. Nothing here needs a specific shell.
    const readFirstByte = (dev: string, tag: string): { out: string; err: string } => {
      const bin = `/tmp/inflight-${tag}.bin`
      const st = `/tmp/inflight-${tag}.rc`
      sh(
        `sudo -n dd if=${dev} bs=1 skip=$(( 8 * 1048576 )) count=1 of=${bin} 2>/tmp/inflight-${tag}.err; ` +
          `echo $? > ${st}`,
      )
      const byte = sh(`sudo -n od -An -tu1 ${bin} 2>/dev/null | head -1`)
      const rc = sh(`cat ${st} 2>/dev/null || echo missing`).out.trim() || 'missing'
      return { out: `${oneLine(byte.out, 24)}\n|rc=${rc}`, err: '' }
    }
    const ctlByte = readFirstByte(ctlDev, 'ctl')
    const expByte = readFirstByte(expDev, 'exp')
    note(`inflight-control-first-byte=${oneLine(ctlByte.out, 60) || 'EMPTY'}`)
    note(`inflight-expect-first-byte=${oneLine(expByte.out, 60) || 'EMPTY'}`)
    note(`inflight-control-read-err=${oneLine(sh('cat /tmp/inflight-ctl.err 2>/dev/null || echo none').out, 100)}`)
    note(`inflight-expect-read-err=${oneLine(sh('cat /tmp/inflight-exp.err 2>/dev/null || echo none').out, 100)}`)
    // The byte and the exit status are parsed from two separate lines rather
    // than pattern-matched against one blob. `/^\s*0\s*$/` against a string
    // that also carries a status marker can never match, and the verdict would
    // then have been `control-did-not-land-measurement-invalid` on every run:
    // a parse failing, dressed as a finding.
    const byteOf = (out: string): string => {
      const first = out.split('\n')[0].trim()
      return /^\d+$/.test(first) ? first : `unparsed:${oneLine(first, 24) || 'EMPTY'}`
    }
    const rcOf = (out: string): string => /(?:^|\n)\|rc=(\d+)/.exec(out)?.[1] ?? 'missing'
    const ctlVal = byteOf(ctlByte.out)
    const expVal = byteOf(expByte.out)
    note(`inflight-control-byte=${ctlVal} rc=${rcOf(ctlByte.out)}`)
    note(`inflight-expect-byte=${expVal} rc=${rcOf(expByte.out)}`)
    // `dd if=/dev/zero` writes zeroes, so "the medium holds the write" is
    // indistinguishable from "nothing was ever written". The two are separated
    // here by seeding a non-zero pattern at the same offset of *both* images
    // first: a zero after the experiment therefore means the write landed, and
    // a non-zero means it did not. The seed itself was checked above
    // (`inflight-seeded=yes`), so a zero here is not "the seed was never
    // written".
    const ctlZero = ctlVal === '0'
    const expZero = expVal === '0'
    note(`inflight-control-zero=${ctlZero ? 'yes' : 'no'}`)
    note(`inflight-expect-zero=${expZero ? 'yes' : 'no'}`)
    // A read that failed cannot say what the medium holds. Kept out of the
    // verdict rather than folded into "did not land", because the two look
    // identical from a zero-length read and mean opposite things.
    const ctlReadable = !ctlVal.startsWith('unparsed') && rcOf(ctlByte.out) === '0'
    const expReadable = !expVal.startsWith('unparsed') && rcOf(expByte.out) === '0'
    note(`inflight-both-readable=${ctlReadable && expReadable ? 'yes' : 'no'}`)
    note(
      'inflight-verdict=' +
        (!ctlReadable || !expReadable
          ? 'read-back-failed-no-reading'
          : ctlZero && !expZero
            ? 'delayed-write-did-not-land'
            : ctlZero && expZero
              ? 'both-landed-write-had-already-completed'
              : 'control-did-not-land-measurement-invalid'),
    )
    // The verdict above can be read only if the write was genuinely still
    // outstanding at the moment of the cut. Reported separately, because
    // `delayed-write-did-not-land` after the process had already exited means
    // the loss came from something else entirely.
    note(`inflight-write-was-inflight=${ddState === 'running' ? 'yes' : ddState === 'gone' ? 'no' : 'unknown'}`)

    sh(`sudo -n losetup -d ${ctlDev} 2>/dev/null || true`)
    sh(`sudo -n losetup -d ${expDev} 2>/dev/null || true`)
    sh('sudo -n rm -f /tmp/inflight-ctl.img /tmp/inflight-exp.img')

    expect(reached('inflight-verdict=')).toBe(true)
  }, 600_000)

  // ---------------------------------------------------------------------
  // 4. A machine that loses power mid-write.
  //
  // Killing one process leaves the kernel and its page cache alive. A power
  // cut takes the whole kernel down at once, so the only writes that survive
  // are the ones already on the device. That is simulated here by booting a
  // minimal guest in QEMU, letting it write in a loop, and SIGKILLing the
  // emulator: no shutdown, no sync, no unmount. The disk image is then read
  // back on the host.
  // ---------------------------------------------------------------------
  it('linux: a guest killed mid-write leaves a whole value on the disk', () => {
    if (!isLinux) {
      note(`psu=skip platform=${process.platform}`)
      expect(log.length).toBeGreaterThan(0)
      return
    }

    note('psu-kernel=' + oneLine(sh('uname -r').out, 80))
    note('psu-boot=' + oneLine(sh('ls /boot 2>/dev/null | tr "\n" " "').out, 200))
    const builtin = sh('cat /lib/modules/$(uname -r)/modules.builtin 2>/dev/null | tr "\n" " "').out
    note(`psu-virtio-blk-builtin=${/virtio_blk/.test(builtin) ? 'yes' : 'no'}`)
    note(`psu-ata-piix-builtin=${/ata_piix/.test(builtin) ? 'yes' : 'no'}`)
    // The initramfs carries no modules, so the guest can only mount what the
    // kernel already has. Asking before the boot turns "unknown filesystem"
    // in the serial log into one line that says why.
    const ext4Builtin = /ext4/.test(builtin)
    note(`psu-ext4-builtin=${ext4Builtin ? 'yes' : 'no'}`)

    const vmlinuz = sh('ls /boot/vmlinuz-* 2>/dev/null | head -1').out.trim()
    note(`psu-vmlinuz=${vmlinuz || 'none'}`)

    if (!vmlinuz) {
      note('psu=unavailable reason=no-kernel-image-on-image')
      expect(reached('psu-vmlinuz=')).toBe(true)
      return
    }
    const iface = /virtio_blk/.test(builtin) ? 'virtio' : /ata_piix/.test(builtin) ? 'ide' : ''
    note(`psu-iface=${iface || 'none'}`)
    if (!iface) {
      note('psu=unavailable reason=no-builtin-block-driver')
      expect(reached('psu-iface=')).toBe(true)
      return
    }
    if (!ext4Builtin) {
      note('psu=unavailable reason=ext4-not-builtin')
      expect(reached('psu-ext4-builtin=')).toBe(true)
      return
    }

    const apt = sh(
      'sudo -n apt-get install -y -qq --no-install-recommends qemu-system-x86 busybox-static cpio >/dev/null 2>&1; ' +
        'command -v qemu-system-x86_64 >/dev/null && echo qemu-ok || echo qemu-missing',
      600_000,
    )
    note(`psu-packages=${oneLine(apt.out, 120)}`)
    if (!/qemu-ok/.test(apt.out)) {
      note('psu=unavailable reason=qemu-not-installable')
      expect(reached('psu-packages=')).toBe(true)
      return
    }

    // A 64 MB data disk, formatted on the host and seeded with v0.
    //
    // A function rather than a one-shot: the second arm below needs the same
    // disk back in its seeded state, and rebuilding it by hand is how the two
    // arms drift apart without anyone noticing.
    const seedImage = () => {
      sh('sudo -n rm -f /tmp/psu.img && truncate -s 64M /tmp/psu.img && sudo -n mkfs.ext4 -q /tmp/psu.img')
      sh('sudo -n mkdir -p /mnt/psu && sudo -n mount -o loop /tmp/psu.img /mnt/psu && echo v0 | sudo -n tee /mnt/psu/target >/dev/null && sudo -n umount /mnt/psu')
    }
    seedImage()
    note('psu-image=' + oneLine(sh('ls -l /tmp/psu.img | tr -s " "').out, 120))

    // Minimal initramfs: busybox, an ext4 mount, and an infinite rename loop.
    //
    // The archive holds only /init and /bin/busybox, so every mount point below
    // is created by the script itself. An earlier version mounted straight into
    // /proc and /sys, got ENOENT, and fell off the end of the script -- the
    // kernel logged that as "Attempted to kill init! exitcode=0x00000004" and
    // rebooted, which looks like a crash but was the script finishing.
    const expectedInit = [
      '#!/bin/busybox sh',
      // Straight to stdout, with a shell builtin and no redirect: the kernel
      // wires init's fd 1 to /dev/console, so this line prints if the shell
      // runs the file at all. It is the bisection point -- if this is missing
      // and the control init below prints, the problem is in this file; if
      // both are missing, the problem is the exec path, not the script.
      'echo "PSU 00-stdout-alive pid=$$"',
      // No 'busybox --install -s': it creates a few hundred symlinks in the
      // rootfs and, if that rootfs is a ramfs with a small size limit, it is
      // the first thing that fails. Every command is called through the applet
      // path instead, which needs no link at all -- which also means every
      // call below has to name $BB. A bare `mount` here resolves against PATH,
      // finds no such file, and reports rc=127 into a marker that reads like a
      // kernel refusal.
      'BB=/bin/busybox',
      // /dev does not exist in this archive, and the kernel opens /dev/console
      // before it ever runs init: without the node, the first marker has
      // nowhere to go and the run looks silent again. mkdir and mknod run
      // first, before say(), for that reason.
      '$BB mkdir -p /proc /sys /dev /tmp /data /mnt; r=$?',
      '$BB mknod /dev/console c 5 1 2>/dev/null; $BB mknod /dev/ttyS0 c 4 64 2>/dev/null; true',
      // One marker per line reached: the previous run could say only that init
      // exited with code 4 and not which line produced it. `echo` is a shell
      // builtin, so say() no longer depends on an applet existing: the earlier
      // version ran `$BB printf`, and an applet that is not compiled in prints
      // its complaint to a stderr that was redirected to /dev/null.
      'say() { echo "$1" > /dev/ttyS0 2>/dev/null || echo "$1"; }',
      'say "PSU 01-init-entered pid=$$ apt=$BB mkdir-rc=$r"',
      'say "PSU 02-mkdir rc=$r"',
      '$BB mount -t proc proc /proc; r=$?; say "PSU 03-proc rc=$r"',
      '$BB mount -t sysfs sysfs /sys; r=$?; say "PSU 04-sysfs rc=$r"',
      '$BB mount -t devtmpfs dev /dev; r=$?; say "PSU 05-devtmpfs rc=$r"',
      'if [ ! -c /dev/ttyS0 ]; then $BB mknod /dev/ttyS0 c 4 64; r=$?; say "PSU 06-mknod-ttyS0 rc=$r"; fi',
      'if [ ! -b /dev/vda ]; then $BB mknod /dev/vda b 254 0; r=$?; say "PSU 07-mknod-vda rc=$r"; fi',
      'say "PSU 08-about-to-mount-disk"',
      'if $BB mount -t ext4 /dev/vda /data; then say "PSU 09-mount-vda rc=0"; ' + 'else $BB mount -t ext4 /dev/sda /data; r=$?; say "PSU 09-mount-sda rc=$r"; fi',
      'if [ -d /data/lost+found ]; then say "PSU 10-disk-mounted"; else say "PSU 10-no-disk"; fi',
      'i=1',
      'while true; do',
      '  echo "v$i" > /data/target.tmp',
      '  $BB mv /data/target.tmp /data/target',
      '  i=$((i+1))',
      '  if [ $((i % 200)) -eq 0 ]; then say "PSU wrote $i"; fi',
      '  $BB sleep 0.01',
      'done',
      '',
    ].join('\n')
    writeFileSync('/tmp/psu-init', expectedInit)

    // A control init that does nothing but print, through both channels, and
    // then powers off so qemu exits on its own and flushes the serial file --
    // a SIGKILL loses whatever is still in that buffer, which is how the first
    // control run appeared to stop before it had even reached init.
    writeFileSync(
      '/tmp/psu-control-init',
      [
        '#!/bin/busybox sh',
        'echo "PSU 00-control-stdout"',
        'echo "PSU 00-control-ttyS0" > /dev/ttyS0',
        '/bin/busybox poweroff -f',
      ].join('\n'),
    )

    // The kernel opens /dev/console before it runs init, so the archive has to
    // carry that node; mknod needs root, hence sudo for those two entries and
    // for the packing step that reads them.
    const buildArchive = (init: string, out: string) =>
      sh(
        'sudo -n rm -rf /tmp/ird && mkdir -p /tmp/ird/bin /tmp/ird/dev && ' +
          `cp "$(command -v busybox)" /tmp/ird/bin/busybox && cp ${init} /tmp/ird/init && ` +
          'chmod 0755 /tmp/ird/init /tmp/ird/bin/busybox && ' +
          'sudo -n mknod /tmp/ird/dev/console c 5 1 && sudo -n mknod /tmp/ird/dev/ttyS0 c 4 64 && ' +
          `sudo -n sh -c "cd /tmp/ird && find . | cpio --quiet -o -H newc 2>/tmp/cpio.err | gzip -1" > ${out} && ` +
          `echo "size=$(stat -c %s ${out})"`,
        180_000,
      )
    const rd = buildArchive('/tmp/psu-init', '/tmp/initrd.gz')
    note('psu-initrd=' + oneLine(rd.out, 300))
    note('psu-cpio-err=' + oneLine(sh('cat /tmp/cpio.err 2>/dev/null || true').out, 200))
    note('psu-initrd-entries=' + oneLine(sh('gzip -dc /tmp/initrd.gz | cpio -it --quiet 2>/dev/null || true').out, 300))
    note('psu-control-initrd=' + oneLine(buildArchive('/tmp/psu-control-init', '/tmp/ctl.gz').out, 120))

    // Print the serial log from the moment the kernel hands over to init. The
    // earlier version printed only the lines matching a regex, which is how a
    // complaint from the shell itself stayed invisible for two runs: the log
    // was 30 KB and seven lines of it were shown.
    const dumpSerial = (path: string, tag: string) => {
      const all = sh(`cat ${path} 2>/dev/null || true`).out.split('\n')
      const at = all.findIndex((l) => l.includes('Run /init'))
      const from = at >= 0 ? all.slice(at) : all.slice(-40)
      note(`${tag}-serial-lines=${all.length} from-init=${from.length}`)
      for (const l of from.slice(0, 90)) note(`${tag}| ` + l.slice(0, 220))
    }

    // Unpack the archive on the host and look at /init exactly as the kernel
    // will see it. The guest's first line never ran, so the question is whether
    // the file is executable, whether its shebang names a path that exists
    // inside the archive, and whether busybox's own mode bits survived cpio.
    // These are cheap to check here and expensive to discover from a
    // register dump.
    const rdCheck = sh(
      'rm -rf /tmp/irdx && mkdir -p /tmp/irdx && gzip -dc /tmp/initrd.gz | cpio -id --quiet -D /tmp/irdx 2>/dev/null; ' +
        'ls -l /tmp/irdx/init /tmp/irdx/bin/busybox 2>&1; ' +
        'echo "first=$(head -c 40 /tmp/irdx/init 2>/dev/null | od -c | head -2 | tr \'\\n\' \' \')"; ' +
        'if [ -x /tmp/irdx/init ] && /tmp/irdx/init --help >/dev/null 2>&1; then echo "selfexec=ok"; else echo "selfexec=rc=$?"; fi',
      60_000,
    )
    note('psu-initrd-check=' + oneLine(rdCheck.out, 700))
    // The whole of /init, one log line per source line, compared against what
    // was handed to writeFileSync. Everything above trims, joins or octal-dumps
    // some part of it; this does not, so a difference in the file is a
    // difference that can be pointed at.
    const dump = sh(
      'rm -rf /tmp/irdx2 && mkdir -p /tmp/irdx2 && gzip -dc /tmp/initrd.gz | cpio -id --quiet -D /tmp/irdx2 2>/dev/null; ' +
        'wc -c < /tmp/irdx2/init; ' +
        'cat -A /tmp/irdx2/init | nl -ba -w3 -s" " | head -40',
      60_000,
    )
    for (const line of dump.out.split('\n')) {
      note('initdump| ' + line.slice(0, 220))
    }
    note('initdump-expected-bytes=' + String(expectedInit.length))

    // `${vmlinuz}` holds a path that already went through one shell, so it is
    // resolved to a literal here: interpolating it inside `sh -c '...'` leaves
    // any remaining $( ) for a second expansion, which fails silently and
    // leaves the guest to boot the image's own kernel and initrd instead.
    const kernelPath = sh(`readlink -f '${vmlinuz}'`).out.trim()
    const kernelArg = /^\/[\w\/.+-]+$/.test(kernelPath) ? kernelPath : vmlinuz
    note(`psu-kernel-arg=${kernelArg}`)
    // Foreground, not `&`: an earlier form took setsid's pid, the wrapper
    // script exited at once, and QEMU was gone within 33 microseconds. Let a
    // killer inside the same shell end it after the guest has had time to
    // write, and keep QEMU's own stderr out of the serial stream so a startup
    // failure is readable instead of being swallowed as if it were guest
    // output.
    //
    // `alive=` is sampled inside this same shell, while QEMU is still up.
    // Reading pgrep from Node afterwards only says whether the kill worked,
    // which is not the question -- a 0 there could not distinguish "never
    // started" from "killed on purpose".
    // `-cpu max`, because the default qemu64 model has no AVX and the
    // runner's busybox-static is compiled with it: the guest died with
    // `traps: init[1] trap invalid opcode ... <c5> f9 6f` (a VEX-encoded
    // vmovdqa) before it executed a line of the script, and the kernel
    // reported that as `exitcode=0x00000004` -- signal 4, SIGILL, not an
    // exit status. Every reading of "the script exits with 4" was this.
    const boot = (initrd: string, serial: string, seconds: number, drive = '/tmp/psu.img', cache = '') =>
      sh(
        `sudo -n sh -c 'qemu-system-x86_64 -m 256 -smp 2 -cpu max -nodefaults -no-reboot ` +
          `-kernel ${kernelArg} -initrd ${initrd} ` +
          `-append "console=ttyS0 panic=1 rdinit=/init" ` +
          `-drive file=${drive},if=${iface},format=raw${cache} ` +
          `-serial file:${serial} -monitor none -display none -vga none ` +
          `2>/tmp/qemu.err & qpid=$!; ` +
          // Counted from `/proc/*/comm`, not from `pgrep`. Two failed forms
          // are recorded below at the after-kill reading; the short version is
          // that `pgrep -x qemu-system-x86_64` can never match, because the
          // kernel truncates `comm` to fifteen characters and this name is
          // eighteen, so the count was 0 on every run -- including runs where
          // the pid printed on the next line was demonstrably alive.
          `sleep ${seconds}; ` +
          `echo "alive=$(grep -lx qemu-system-x86 /proc/[0-9]*/comm 2>/dev/null | wc -l)"; ` +
          `kill -9 $qpid 2>/dev/null; echo "qemu-pid=$qpid"'`,
        (seconds + 45) * 1000,
      )

    // The control boot runs first and costs six seconds. If it prints
    // `PSU 00-control` and the real script prints nothing, the harness is
    // fine and the fault is in the script; if it prints nothing either, the
    // fault is in how the guest is started, and no amount of editing the
    // script would have found that.
    const ctl = boot('/tmp/ctl.gz', '/tmp/serial-ctl.log', 8)
    note('psu-control-launch=' + oneLine(ctl.out, 160))
    dumpSerial('/tmp/serial-ctl.log', 'ctl')
    // Two channels, so the answer is not a single yes: stdout is what the
    // kernel wired to /dev/console, ttyS0 is what the script writes by name.
    const ctlLog = sh('cat /tmp/serial-ctl.log 2>/dev/null || true').out
    note('psu-control-stdout=' + (/PSU 00-control-stdout/.test(ctlLog) ? 'yes' : 'no'))
    note('psu-control-ttyS0=' + (/PSU 00-control-ttyS0/.test(ctlLog) ? 'yes' : 'no'))

    const launched = boot('/tmp/initrd.gz', '/tmp/serial.log', 25)
    note('psu-launch=' + oneLine(launched.out, 220))
    note('psu-exit=' + String(launched.status))
    note('psu-qemu-stderr=' + oneLine(sh('cat /tmp/qemu.err 2>/dev/null || true').out, 500))

    // `psu-qemu-alive-during` now comes from the shell that owned the process,
    // not from a pgrep after the kill: a 0 here means the emulator failed at
    // startup rather than that the kill worked.
    const aliveMatch = /alive=(\d+)/.exec(launched.out)
    note(`psu-qemu-alive-during=${aliveMatch ? aliveMatch[1] : 'unknown'}`)
    sh('sudo -n pkill -9 -f qemu-system-x86_64 || true')
    sleepSync(1_000)
    // Two wrong forms of this count are worth recording, because both returned
    // a fixed number and a fixed number reads like a measurement:
    //
    //   `pgrep -cf qemu-system-x86`  counts its own `sh -c` wrapper, whose
    //     command line contains the pattern, so it reported 1 on every run --
    //     including runs where the kill had worked.
    //   `pgrep -x qemu-system-x86_64` can never match: the kernel caps `comm`
    //     at fifteen characters (TASK_COMM_LEN 16 with the NUL) and this name
    //     is eighteen, so pgrep printed `pattern that searches for process
    //     name longer than 15 characters will result in zero matches` and the
    //     count was 0 on every run. The reading looked like "no leftovers"
    //     while the line above it printed a live pid.
    //
    // Reading `/proc/*/comm` and matching the truncated name works, but only
    // if something proves it can return non-zero. `alive=` above is that
    // control: same expression, sampled while QEMU was certainly up. A zero
    // here means leftovers only when that control was at least one.
    const commCount = (): string => {
      const r = sh('grep -lx "qemu-system-x86" /proc/[0-9]*/comm 2>/dev/null | wc -l')
      return r.status === 0 ? r.out.trim() || '0' : `rc=${r.status}`
    }
    note(`psu-qemu-processes-after-kill=${commCount()}`)
    note(`psu-qemu-count-method-control=${aliveMatch && aliveMatch[1] !== '0' ? 'can-count' : 'never-saw-one'}`)

    const serial = sh('cat /tmp/serial.log 2>/dev/null || true').out
    note(`psu-serial-bytes=${serial.length}`)
    // Everything from the handover to init onward, unfiltered. The previous
    // version printed only the lines matching a regex -- seven of them out of a
    // 30 KB log -- so any line the shell wrote about itself was dropped on the
    // floor, and the run looked like silence rather than like an error.
    dumpSerial('/tmp/serial.log', 'psu')
    const qemuLog = serial
    // The guest reports its own progress, because a guest that never mounted
    // or never wrote would leave the seed value in place, which would read as
    // a pass. Mount and at least one completed write are both required.
    // The marker is `PSU 10-disk-mounted`; a pattern of `PSU disk-mounted`
    // matches nothing, so a guest that mounted fine would still be read as
    // "could not mount" and the run would report the wrong reason.
    const mounted = /PSU 10-disk-mounted/.test(qemuLog)
    const wroteMarkers = qemuLog.match(/PSU wrote (\d+)/g) || []
    const lastWrote = wroteMarkers.length ? wroteMarkers[wroteMarkers.length - 1].replace('PSU wrote ', '') : 'none'
    note(`psu-guest-mounted=${mounted ? 'yes' : 'no'}`)
    note(`psu-guest-writes=${lastWrote}`)
    if (!mounted || !wroteMarkers.length) {
      note(
        'psu=unavailable reason=' +
          (mounted ? 'guest-mounted-but-wrote-nothing' : 'guest-could-not-mount-the-disk'),
      )
      sh('sudo -n rm -f /tmp/psu.img /tmp/initrd.gz; rm -rf /tmp/ird /tmp/psu-init')
      expect(reached('psu=unavailable')).toBe(true)
      return
    }

    // `noload` because the guest was killed, so the journal is dirty and a
    // plain `-o ro` would try to replay it. Replay is the wrong operation
    // here: the question is what the disk held at the moment it stopped, not
    // what a recovery pass would reconstruct from it.
    const readBack = sh(
      'sudo -n mount -o ro,noload,loop /tmp/psu.img /mnt/psu 2>/dev/null; ' +
        'cat /mnt/psu/target 2>/dev/null || echo MISSING; ' +
        'ls /mnt/psu | tr "\n" " "; sudo -n umount /mnt/psu 2>/dev/null || true',
      120_000,
    )
    const value = readBack.out.split('\n')[0].trim()
    note(`psu-target=${value || 'missing'}`)
    note('psu-listing=' + oneLine(readBack.out.split('\n').slice(1).join(' '), 160))

    sh('sudo -n rm -f /tmp/psu.img /tmp/initrd.gz; rm -rf /tmp/ird /tmp/psu-init')

    // The claim under test: after an abrupt loss the target is either the seed
    // or a complete later value -- never a torn or empty file -- because the
    // writer replaces it by rename.
    const whole = value === 'v0' || /^v\d+$/.test(value)
    note(`psu-target-whole=${whole ? 'yes' : 'no'}`)

    // ------------------------------------------------------------------
    // The second arm: a cut that reaches the medium, not just the process.
    //
    // The first arm kills the emulator while the guest has issued renames
    // but has not flushed them. What survives is decided by the guest's own
    // page cache, so `psu-target=v0` says "the guest had not written it
    // down yet" -- it does not say anything about a disk that has already
    // acknowledged data it is still holding in volatile memory. That second
    // case is what a real power cut destroys, and it is a different link in
    // the chain: write -> page cache -> writeback -> block layer -> device
    // cache -> medium.
    //
    // Two changes make the second arm test that link:
    //
    //   * the guest calls `sync` before every marker, so the write reaches
    //     the device and the rename is durable from the guest's side. The
    //     guest is entitled to consider it committed.
    //   * the disk is attached `cache=writeback`, so the device acks the
    //     write while the data is in the *host's* page cache. Killing qemu
    //     with SIGKILL throws that cache away -- which is what losing power
    //     to the device does, and is the failure the guest cannot see.
    //
    // The read-back then drops the host page cache first. Without that step
    // the host would serve the value out of the same cache that a crash
    // would have erased, and the arm would pass for the wrong reason.
    //
    // What this still cannot do is state a verdict about real hardware:
    // there is no in-flight DMA, no drive-level write cache, and no torn
    // sector. It closes the "acknowledged but not on the medium" link and
    // leaves the other two named.
    // ------------------------------------------------------------------
    const durableInit = expectedInit.replace(
      [
        'i=1',
        'while true; do',
        '  echo "v$i" > /data/target.tmp',
        '  $BB mv /data/target.tmp /data/target',
        '  i=$((i+1))',
        '  if [ $((i % 200)) -eq 0 ]; then say "PSU wrote $i"; fi',
        '  $BB sleep 0.01',
        'done',
      ].join('\n'),
      [
        'i=1',
        'while true; do',
        '  echo "v$i" > /data/target.tmp',
        // The rename is made durable from the guest's point of view before
        // the marker is printed, so `PSU synced N` means "N renames the guest
        // had committed", not "N renames it had issued". That distinction is
        // the whole second arm: an issued-but-unflushed rename is the first
        // arm, an acknowledged-and-flushed one is this one.
        // `;` and not `&&`: a failed `mv` must not also skip the sync in a way
        // that silently ends the loop, and it must not hide the failure --
        // the marker line below is what reports progress either way.
        '  $BB mv /data/target.tmp /data/target; $BB sync',
        // The count is printed before the increment, so `PSU synced 50` means
        // fifty. The line it replaces printed after the increment and was
        // therefore always one ahead of what had actually been done.
        '  if [ $((i % 50)) -eq 0 ]; then say "PSU synced $i"; fi',
        '  i=$((i+1))',
        '  $BB sleep 0.01',
        'done',
      ].join('\n'),
    )
    if (durableInit === expectedInit) {
      // A string replace that silently matched nothing would make the two
      // arms identical while the log still claimed two of them.
      note('psu-sync=unavailable reason=init-edit-did-not-apply')
    } else {
      writeFileSync('/tmp/psu-sync-init', durableInit)
      const syncRd = buildArchive('/tmp/psu-sync-init', '/tmp/sync.gz')
      note('psu-sync-initrd=' + oneLine(syncRd.out, 120))

      // The control arm for this pair. Same script, same disk, same
      // `cache=writeback` -- but the guest powers off by itself instead of
      // being killed, so qemu exits normally and nothing volatile is thrown
      // away. Without this, a read-back of `v0` after a kill has two
      // explanations that look identical in the log: the acknowledged writes
      // were lost, or the guest never got far enough to write them. The
      // control separates them: it must read back at its own marker.
      const controlInit = durableInit.replace(
        '  $BB sleep 0.01',
        // Bounded, so the control exits on its own after a known number of
        // renames rather than waiting for a kill it will not get.
        '  if [ $i -ge 150 ]; then say "PSU control-done $i"; $BB poweroff -f; fi\n  $BB sleep 0.01',
      )
      if (controlInit === durableInit) {
        note('psu-sync-control=unavailable reason=bounded-exit-not-applied')
      } else {
        writeFileSync('/tmp/psu-sync-ctl', controlInit)
        note('psu-sync-control-initrd=' + oneLine(buildArchive('/tmp/psu-sync-ctl', '/tmp/syncctl.gz').out, 120))
        seedImage()
        const ctlBoot = boot('/tmp/syncctl.gz', '/tmp/serial-syncctl.log', 40, '/tmp/psu.img', ',cache=writeback')
        note('psu-sync-control-launch=' + oneLine(ctlBoot.out, 220))
        sh('sudo -n pkill -9 -f qemu-system-x86_64 || true')
        sleepSync(1_000)
        const ctlSyncLog = sh('cat /tmp/serial-syncctl.log 2>/dev/null || true').out
        const ctlMarks = ctlSyncLog.match(/PSU synced (\d+)/g) || []
        const ctlLast = ctlMarks.length ? ctlMarks[ctlMarks.length - 1].replace('PSU synced ', '') : 'none'
        const ctlDone = /PSU control-done (\d+)/.exec(ctlSyncLog)
        note(`psu-sync-control-writes=${ctlLast}`)
        note(`psu-sync-control-exited=${ctlDone ? 'yes' : 'no'}`)
        // Same cache-drop procedure as the killed arm below, so the two are
        // read under the same conditions; the outcome is recorded there.
        sh(
          'sync; if sudo -n sh -c "echo 3 > /proc/sys/vm/drop_caches" 2>/dev/null; then echo dropped; ' +
            'elif sh -c "echo 3 > /proc/sys/vm/drop_caches" 2>/dev/null; then echo dropped; ' +
            'else echo refused; fi',
          120_000,
        )
        const ctlBack = sh(
          'sudo -n mount -o ro,noload,loop /tmp/psu.img /mnt/psu 2>/dev/null; ' +
            'cat /mnt/psu/target 2>/dev/null || echo MISSING; ' +
            'sudo -n umount /mnt/psu 2>/dev/null || true',
          120_000,
        )
        const ctlValue = ctlBack.out.split('\n')[0].trim()
        note(`psu-sync-control-target=${ctlValue || 'missing'}`)
        const ctlLastN = ctlLast === 'none' ? -1 : Number(ctlLast)
        const ctlTargetN = /^v\d+$/.test(ctlValue) ? Number(ctlValue.slice(1)) : -1
        // Same marker band as the killed arm, so the two are compared with the
        // same ruler. The control exits by itself, so its last marker is also
        // a lower bound rather than the exact count.
        note(`psu-sync-control-durable=${ctlTargetN >= 0 && ctlLastN >= 0 && ctlTargetN >= ctlLastN - 50 ? 'yes' : 'no'}`)
      }

      seedImage()
      const syncBoot = boot('/tmp/sync.gz', '/tmp/serial-sync.log', 30, '/tmp/psu.img', ',cache=writeback')
      note('psu-sync-launch=' + oneLine(syncBoot.out, 220))
      sh('sudo -n pkill -9 -f qemu-system-x86_64 || true')
      sleepSync(1_000)
      const syncLog = sh('cat /tmp/serial-sync.log 2>/dev/null || true').out
      const syncMarks = syncLog.match(/PSU synced (\d+)/g) || []
      const lastSynced = syncMarks.length ? syncMarks[syncMarks.length - 1].replace('PSU synced ', '') : 'none'
      note(`psu-sync-writes=${lastSynced}`)
      note(`psu-sync-mounted=${/PSU 10-disk-mounted/.test(syncLog) ? 'yes' : 'no'}`)
      if (!syncMarks.length) {
        note('psu-sync=unavailable reason=guest-synced-nothing')
      } else {
        // Drop the host page cache before reading. `sync` alone would only
        // push dirty pages out; the point is to make the next read come from
        // the medium, so the cache cannot answer a question that a power cut
        // would have answered differently.
        //
        // The outcome is recorded rather than assumed: if the drop is refused
        // (the file is not writable on every image, and a container may not
        // permit it), the read-back may be served from cache, and a `v0` then
        // proves less. Saying which happened keeps the verdict honest.
        const drop = sh(
          'sync; if sudo -n sh -c "echo 3 > /proc/sys/vm/drop_caches" 2>/dev/null; then echo dropped; ' +
            'elif sh -c "echo 3 > /proc/sys/vm/drop_caches" 2>/dev/null; then echo dropped; ' +
            'else echo refused; fi',
          120_000,
        )
        note(`psu-sync-drop-caches=${oneLine(drop.out, 40) || 'unknown'}`)
        const syncBack = sh(
          'sudo -n mount -o ro,noload,loop /tmp/psu.img /mnt/psu 2>/dev/null; ' +
            'cat /mnt/psu/target 2>/dev/null || echo MISSING; ' +
            'sudo -n umount /mnt/psu 2>/dev/null || true',
          120_000,
        )
        const syncValue = syncBack.out.split('\n')[0].trim()
        note(`psu-sync-target=${syncValue || 'missing'}`)
        note(`psu-sync-target-whole=${/^v\d+$/.test(syncValue) ? 'yes' : 'no'}`)
        // Two facts, reported separately, because they answer different
        // questions and one of them is the whole point of this arm.
        //
        //   * `psu-sync-acked`  -- how far the guest got before the cut. This
        //     is what the guest was entitled to believe was committed.
        //   * `psu-sync-durable` -- whether the value on the medium is at or
        //     past that point. `no` here is the "acknowledged and then lost"
        //     reading: the guest called sync, so it was told the bytes were
        //     down, and the medium disagrees. That is the failure mode a real
        //     power cut produces and no process-level kill can.
        //
        // The comparison is exact, not tolerant: the seed is `v0` and every
        // later value is `v<N>` with N strictly increasing, so `target >=
        // acked` is the only reading that means "nothing acknowledged was
        // lost". A tolerance here would call `v0` against 50 synced writes a
        // pass, which is exactly the case worth reporting.
        const acked = lastSynced === 'none' ? -1 : Number(lastSynced)
        const durable = /^v\d+$/.test(syncValue) ? Number(syncValue.slice(1)) : -1
        // Two questions, kept apart, because a single tolerance cannot answer
        // both without hiding the case that matters.
        //
        // `psu-sync-lost` is the strict one and the reason this arm exists:
        // the seed is `v0` and only the guest ever raises it, so reading `v0`
        // back after the guest reported `PSU synced N` for N > 0 means the
        // acknowledged renames are not on the medium. No tolerance belongs
        // here -- `v0` is a sentinel, not a small number.
        //
        // `psu-sync-durable` is the softer one: a value at or near the last
        // marker. The marker is printed every 50 renames, so between the last
        // one and the kill the guest may have committed up to 49 more; a value
        // inside that band is "the log stopped counting", not loss.
        const seedKept = durable === 0
        const survived = durable >= 0 && acked >= 0 && durable >= acked - 50
        note(`psu-sync-acked=${acked}`)
        note(`psu-sync-target-n=${durable}`)
        note(`psu-sync-seed-kept=${seedKept ? 'yes' : 'no'}`)
        note(`psu-sync-durable=${survived ? 'yes' : 'no'}`)
        note(
          'psu-sync-verdict=' +
            (acked <= 0
              ? 'guest-synced-nothing'
              : seedKept
                ? 'acked-values-lost'
                : survived
                  ? 'acked-values-survived'
                  : 'acked-values-partly-lost'),
        )

        // ------------------------------------------------------------------
        // A device whose write cache acknowledges and does not persist.
        //
        // The first attempt at this used QEMU's `cache=unsafe`, reasoning that
        // it is the only mode with `cache.no-flush`, so it accepts a guest
        // flush without performing it. That is true of the *host's* page
        // cache, and it is not the property this arm needs: killing the
        // emulator leaves those pages in the host kernel, which writes them
        // back anyway. The arm ran, read `acked-values-survived` on both Node
        // versions, and its own differential marker read `not-shown` -- the
        // reading was correct and the question was wrong.
        //
        // `drop_writes` is the mechanism that actually has the semantics. In
        // `flakey_map` it does `bio_endio(bio); return DM_MAPIO_SUBMITTED`:
        // the write is completed successfully and the data goes nowhere. The
        // guest syncs, is told the bytes are durable, and they are not. That
        // is the drive lying about its flush, produced by the block layer
        // instead of assumed.
        //
        // The guest writes to a dm device over a file-backed loop, not to the
        // file directly, so the lie happens on the guest's own write path.
        // ------------------------------------------------------------------
        seedImage()
        const lieLoop = sh('sudo -n losetup --find --show /tmp/psu.img').out.trim()
        note(`psu-lie-loop=${lieLoop || 'none'}`)
        const lieSectors = lieLoop ? run('sudo', ['-n', 'blockdev', '--getsz', lieLoop], 60_000).out.trim() : ''
        note(`psu-lie-sectors=${lieSectors || 'none'}`)
        if (!lieLoop || !lieSectors) {
          note('psu-lie=unavailable reason=no-loop-device')
          note('psu-lie-verdict=no-reading')
          note('psu-flush-is-the-boundary=not-shown')
        } else {
          // `up=0 down=3600`: down from creation, and `drop_writes` is one
          // feature argument. Its behaviour is silent -- it does not even log
          // -- which is why the reading has to come from the medium.
          const lieTable = sh(
            `echo "0 ${lieSectors} flakey ${lieLoop} 0 0 3600 1 drop_writes" | sudo -n dmsetup create liar`,
          )
          note(`psu-lie-create=${lieTable.status} ${oneLine(lieTable.out, 160)}`)
          note('psu-lie-table=' + oneLine(sh('sudo -n dmsetup table liar 2>&1 || true').out, 200))
          if (lieTable.status !== 0) {
            note('psu-lie=unavailable reason=drop_writes-not-accepted')
            note('psu-lie-verdict=no-reading')
            note('psu-flush-is-the-boundary=not-shown')
          } else {
            const lieBoot = boot('/tmp/sync.gz', '/tmp/serial-lie.log', 30, '/dev/mapper/liar')
            note('psu-lie-launch=' + oneLine(lieBoot.out, 220))
            sh('sudo -n pkill -9 -f qemu-system-x86_64 || true')
            sleepSync(1_000)
            const lieLog = sh('cat /tmp/serial-lie.log 2>/dev/null || true').out
            const lieMarks = lieLog.match(/PSU synced (\d+)/g) || []
            const lieLast = lieMarks.length ? lieMarks[lieMarks.length - 1].replace('PSU synced ', '') : 'none'
            note(`psu-lie-writes=${lieLast}`)
            note(`psu-lie-mounted=${/PSU 10-disk-mounted/.test(lieLog) ? 'yes' : 'no'}`)
            if (!lieMarks.length) {
              note('psu-lie=unavailable reason=guest-synced-nothing')
              // A missing marker must not silently read as "the lie was
              // harmless": the arm produced no reading, and saying so is the
              // only honest outcome.
              note('psu-lie-verdict=no-reading')
              note('psu-flush-is-the-boundary=not-shown')
            } else {
              // Tear the mapper down before reading: the backing file is what
              // the guest's writes were aimed at, and a `drop_writes` layer
              // still in place would swallow nothing at this point but would
              // keep the loop busy.
              //
              // `--force` and a timeout on each step, because the previous run
              // of this arm was still listed as in progress after fifteen
              // minutes on `windows-latest, 26`, and both of these commands can
              // block indefinitely when a reference is still held: `remove`
              // waits for outstanding I/O, `losetup -d` waits for the device to
              // stop being busy. A hang here is indistinguishable from a slow
              // test in the log, so the results are printed and no failure is
              // swallowed.
              const lieRm = sh('sudo -n timeout 30 dmsetup remove --force liar 2>&1 || echo "remove-rc=$?"')
              note(`psu-lie-remove=${oneLine(lieRm.out, 120) || 'quiet'}`)
              const lieLo = sh(`sudo -n timeout 30 losetup -d ${lieLoop} 2>&1 || echo "losetup-rc=$?"`)
              note(`psu-lie-losetup=${oneLine(lieLo.out, 120) || 'quiet'}`)
              sh(
                'sync; if sudo -n sh -c "echo 3 > /proc/sys/vm/drop_caches" 2>/dev/null; then echo dropped; ' +
                  'elif sh -c "echo 3 > /proc/sys/vm/drop_caches" 2>/dev/null; then echo dropped; ' +
                  'else echo refused; fi',
                120_000,
              )
              const lieBack = sh(
                'sudo -n mount -o ro,noload,loop /tmp/psu.img /mnt/psu 2>/dev/null; echo "mount-rc=$?"; ' +
                  'cat /mnt/psu/target 2>/dev/null || echo MISSING; ' +
                  'sudo -n umount /mnt/psu 2>/dev/null || true',
                120_000,
              )
              const lieMountRc = /mount-rc=(\d+)/.exec(lieBack.out)?.[1] ?? 'unknown'
              // `MISSING` has to be told apart from a read that failed: a
              // filesystem that could not be mounted also prints `MISSING`, and
              // reading that as "the acknowledged values were lost" is exactly
              // the wrong conclusion from a broken read path.
              note(`psu-lie-mount-rc=${lieMountRc}`)
              const lieValue = lieBack.out.split('\n').find((l) => !/^mount-rc=/.test(l))?.trim() ?? ''
              const lieAcked = Number(lieLast)
              const lieDurable = /^v\d+$/.test(lieValue) ? Number(lieValue.slice(1)) : -1
              note(`psu-lie-target=${lieValue || 'missing'}`)
              note(`psu-lie-acked=${lieAcked}`)
              note(`psu-lie-target-n=${lieDurable}`)
              // Exactly one verdict line is emitted. The first version wrote
              // one inside the mount-failure branch and another below it, so a
              // failed read-back would have printed `no-reading` and then
              // overwritten it with a verdict computed from `MISSING`.
              if (lieMountRc !== '0') {
                note('psu-lie=unavailable reason=read-back-mount-failed')
                note('psu-lie-verdict=no-reading')
                note('psu-flush-is-the-boundary=not-shown')
              } else {
                // The strict question, and the one this arm exists to answer:
                // the guest called sync N times, was told each one was durable,
                // and the medium still holds the seed or a much earlier value.
                // `v0` is a sentinel, so it is reported on its own line rather
                // than folded into a tolerance.
                const lieSeedKept = lieDurable === 0
                note(`psu-lie-seed-kept=${lieSeedKept ? 'yes' : 'no'}`)
                note(
                  'psu-lie-verdict=' +
                    (lieAcked <= 0
                      ? 'guest-synced-nothing'
                      : lieSeedKept
                        ? 'acked-values-lost'
                        : lieDurable >= lieAcked - 50
                          ? 'acked-values-survived'
                          : 'acked-values-partly-lost'),
                )
                // The differential, against the `cache=writeback` arm above:
                // same guest, same sync, same kill, and the only difference is
                // whether the write was allowed to reach the medium. `yes`
                // means one arm kept its acknowledged values and the other did
                // not.
                note(
                  'psu-flush-is-the-boundary=' +
                    (survived && lieDurable >= 0 && lieDurable < acked - 50 ? 'yes' : 'not-shown'),
                )
              }
            }
          }
        }
      }
    }

    sh('sudo -n rm -f /tmp/psu.img /tmp/initrd.gz /tmp/sync.gz; rm -rf /tmp/ird /tmp/psu-init /tmp/psu-sync-init')

    expect(reached('psu-target=')).toBe(true)
    expect(value, 'the target must be a whole value, not a torn write').toMatch(/^v\d+$/)
  }, 900_000)

});
