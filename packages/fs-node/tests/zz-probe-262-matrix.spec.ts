/* eslint-disable */
// PROBE 262 / D: the four things listed as "not measured", measured.
//
// D1 DELETE ON A REAL FILESYSTEM. The delete gap was measured on tmpdir() only.
//    This runs the same three implementations (shipped / shipped+unlink / naive)
//    on each prepared root: local, NFS, WebDAV, vfat, sshfs, SMB -- whatever the
//    platform's setup script managed to mount. A root that failed to mount is
//    reported as `mounted:false`, never silently dropped.
//
// D2 RENAME WINDOW ON A SLOW FILESYSTEM. An atomic replace gets `settle` ms to
//    deliver. On a network mount the delivery can be slower than on APFS/ext4, so
//    this records first-event latency per root at two settle values. If latency
//    approaches the settle value, the window is the constraint, not the driver.
//
// D3 PARENT DELETED MID-WATCH. The published matrix covers a deleted watch ROOT,
//    not a deleted PARENT. This deletes the parent directory of the watched file
//    while the watch is live and records what arrives.
//
// D4 TWO LIVE WATCHES ON ONE FILE. The lattice model covers registration and
//    disposal, not two concurrent registrations. This registers two watches on
//    the same path, writes once, and records what each received and whether
//    stopping one disturbs the other.
import { execFileSync } from 'node:child_process'
import { Context, Service } from 'cordis'
import { watch as chokidarWatch } from 'chokidar'
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  statfsSync, statSync, watch as fswatch, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SETTLE = Number(process.env.PROBE262_SETTLE || 900)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
// Watch errors seen by the naive arm, reported rather than thrown: a root that
// cannot be watched is a reading, not a probe failure.
const WATCH_ERRORS: string[] = []

// --- implementations under test ------------------------------------------------

class PlusUnlink extends Service {
  constructor(ctx: Context) { super(ctx, 'fs') }
  watch(path: string, callback: any, options: any = {}) {
    const filename = resolve(String(path))
    const isFile = !statSync(filename, { throwIfNoEntry: false })?.isDirectory()
    const root = isFile ? dirname(filename) : filename
    return this.ctx.effect(async () => {
      const watcher = chokidarWatch(root, {
        ignoreInitial: true,
        depth: isFile ? 0 : undefined,
        ignored: (p: string) => {
          p = resolve(p)
          if (isFile && p !== root && p !== filename) return true
          return !!options.ignored?.(p)
        },
      })
      const listener = async (p: string) => { try { await callback(resolve(p)) } catch {} }
      watcher.on('add', listener)
      watcher.on('change', listener)
      watcher.on('unlink', async (p: string) => { try { await callback(resolve(p)) } catch {} })
      await new Promise<void>((r) => watcher.once('ready', () => r()))
      return () => watcher.close()
    }, 'ctx.fs.watch()')
  }
}

class Naive extends Service {
  constructor(ctx: Context) { super(ctx, 'fs') }
  watch(path: string, callback: any) {
    const filename = resolve(String(path))
    const root = dirname(filename)
    return this.ctx.effect(async () => {
      const handles: any[] = []
      await new Promise<void>((ready) => {
        const w = fswatch(root, (_e: string, name: string | null) => {
          if (!name) return
          const full = resolve(root, String(name))
          if (full !== filename) return
          Promise.resolve(callback(full)).catch(() => {})
        })
        // A root that cannot be watched at all (SMB, UNC) raises 'error' on the
        // handle. Without a listener that surfaces as an uncaught exception and
        // kills the process, which is what made the Windows jobs exit 1 while
        // every test had passed. The shipped driver already logs it and carries
        // on (packages/fs-node/src/index.ts:64-66), so the naive arm must too --
        // otherwise the two arms differ by error handling, not by delivery.
        w.on('error', (error: any) => { WATCH_ERRORS.push(String(error?.code ?? error?.message)) })
        handles.push(w)
        setTimeout(ready, 150)
      })
      return () => { for (const w of handles) w.close() }
    }, 'ctx.fs.watch()')
  }
}

// --- root preparation ----------------------------------------------------------

const FS_TYPES: Record<number, string> = {
  0x01021994: 'tmpfs', 0xef53: 'ext4', 0x58465342: 'xfs', 0x9123683e: 'btrfs',
  0x6969: 'nfs', 0xff534d42: 'cifs', 0x65735546: 'fuse', 0x794c7630: 'overlayfs',
  0x4d44: 'vfat', 0x1a1f9d0: 'vfat', 0x1a2b3c4d: 'apfs',
}

function fsTypeOf(p: string): string {
  try {
    const { type } = statfsSync(p)
    return FS_TYPES[type] ?? `0x${(type >>> 0).toString(16)}`
  } catch (error: any) {
    return `error:${error?.code ?? error?.message}`
  }
}

function prepareRoots(): { label: string, path: string }[] {
  const rt = process.env.RUNNER_TEMP || tmpdir()
  const script = process.platform === 'win32'
    ? '.probe/setup-windows.ps1'
    : process.platform === 'darwin' ? '.probe/setup-macos.sh' : '.probe/setup-linux.sh'
  try {
    const command = process.platform === 'win32' ? 'powershell' : 'bash'
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(projectRoot, script)]
      : [resolve(projectRoot, script)]
    const out = execFileSync(command, args, { encoding: 'utf8', timeout: 900_000 })
    console.log('PROBE262_SETUP\n' + out.slice(-4000))
  } catch (error: any) {
    console.log('PROBE262_SETUP_FAILED ' + String(error?.message ?? error).slice(0, 500))
  }
  try {
    console.log('PROBE262_MOUNT_STATUS\n' + readFileSync(join(rt, 'mount-status.txt'), 'utf8'))
  } catch {}
  let lines: string[] = []
  try {
    lines = readFileSync(join(rt, 'roots.txt'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {}
  const roots = lines.map((s) => {
    const i = s.indexOf('=')
    return { label: s.slice(0, i), path: s.slice(i + 1) }
  }).filter((r) => r.label && r.path && statSafe(r.path))
  if (!roots.length) roots.push({ label: 'tmp', path: tmpdir() })
  return roots
}

function statSafe(p: string) {
  try { statSync(p); return true } catch { return false }
}

// --- the four measurements -----------------------------------------------------

async function d1DeleteOnRoot(label: string, path: string, load: (ctx: Context) => Promise<() => void>, impl: string) {
  const out = { root: label, impl, seeds: 0, writeOK: 0, renameOK: 0, deleteOK: 0, disposeOK: 0, firstLatency: [] as number[] }
  const base = mkdtempSync(join(path, 'd1-'))
  for (let i = 0; i < 6; i++) {
    const dir = join(base, `s${i}`); mkdirSync(dir)
    const file = join(dir, 'watched.txt'); writeFileSync(file, '0')
    const ctx = new Context()
    const dispose = await load(ctx)
    const marks: number[] = []
    const stop: any = await (ctx as any).fs.watch(file, () => marks.push(Date.now()))
    await sleep(400)
    marks.length = 0

    const t0 = Date.now(); writeFileSync(file, '1'); await sleep(SETTLE)
    if (marks.length) { out.writeOK++; out.firstLatency.push(marks[0] - t0) }
    marks.length = 0

    writeFileSync(join(dir, 'tmp.txt'), '2'); renameSync(join(dir, 'tmp.txt'), file); await sleep(SETTLE)
    if (marks.length) out.renameOK++
    marks.length = 0

    rmSync(file, { force: true }); await sleep(SETTLE)
    if (marks.length) out.deleteOK++
    marks.length = 0

    if (typeof stop === 'function') await stop()
    await dispose?.()
    writeFileSync(join(dir, 'after.txt'), 'x'); await sleep(300)
    if (marks.length === 0) out.disposeOK++
    out.seeds++
  }
  rmSync(base, { recursive: true, force: true })
  const lat = out.firstLatency.slice().sort((a, b) => a - b)
  return {
    ...out,
    firstLatency: undefined,
    latency: lat.length ? { min: lat[0], p50: lat[Math.floor(lat.length / 2)], max: lat[lat.length - 1] } : null,
  }
}

it('probe 262 d1/d2: three implementations on every mounted root', async () => {
  const roots = prepareRoots()
  const Fs = (await import('../src/index.ts')).default
  const impls: [string, (ctx: Context) => Promise<() => void>][] = [
    ['shipped', async (ctx) => { const f: any = await ctx.plugin(Fs); return () => f.dispose() }],
    ['plus-unlink', async (ctx) => { const f: any = await ctx.plugin(PlusUnlink as any); return () => f.dispose() }],
    ['naive-fswatch', async (ctx) => { const f: any = await ctx.plugin(Naive as any); return () => f.dispose() }],
  ]
  for (const r of roots) {
    const fstype = fsTypeOf(r.path)
    for (const [impl, load] of impls) {
      const res = await d1DeleteOnRoot(r.label, r.path, load, impl)
      console.log('PROBE262_ROOTIMPL ' + JSON.stringify({
        platform: process.platform, node: process.version, settle: SETTLE,
        root: r.label, path: r.path, fsType: fstype, ...res,
        watchErrors: WATCH_ERRORS.length ? WATCH_ERRORS.slice(-4) : undefined,
      }))
    }
  }
}, 3_600_000)

it('probe 262 d3: parent directory deleted mid-watch', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'par262-'))
  const results: any[] = []
  for (const [label, mk] of [['file-shape', 'file'], ['dir-shape', 'dir']] as const) {
    const parent = join(tmp, `parent-${label}`); mkdirSync(parent)
    const file = join(parent, 'watched.txt'); writeFileSync(file, '0')
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const events: string[] = []
    const target = mk === 'file' ? file : parent
    const stop: any = await ctx.fs.watch(target, (p: any) => events.push(String(p)))
    await sleep(400)
    events.length = 0

    // delete the PARENT, not the watched path itself
    rmSync(parent, { recursive: true, force: true })
    await sleep(SETTLE)
    const afterDelete = events.length

    // does the watch survive a recreation of the same parent?
    events.length = 0
    let recreated = false
    try {
      mkdirSync(parent); writeFileSync(file, '2'); recreated = true
    } catch {}
    await sleep(SETTLE)
    const afterRecreate = events.length

    if (typeof stop === 'function') { try { await stop() } catch {} }
    await fiber.dispose()
    results.push({ shape: label, afterParentDelete: afterDelete, afterRecreate, recreated })
  }
  console.log('PROBE262_PARENTDEL ' + JSON.stringify({
    platform: process.platform, node: process.version, settle: SETTLE, results,
  }))
  rmSync(tmp, { recursive: true, force: true })
}, 900_000)

it('probe 262 d4: two live watches on one file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'two262-'))
  const file = join(dir, 'watched.txt'); writeFileSync(file, '0')
  const ctx = new Context()
  const fiber = await ctx.plugin(Fs)

  const a: string[] = []; const b: string[] = []
  const stopA: any = await ctx.fs.watch(file, (p: any) => a.push(String(p)))
  const stopB: any = await ctx.fs.watch(file, (p: any) => b.push(String(p)))
  await sleep(400)
  a.length = 0; b.length = 0

  writeFileSync(file, '1')
  await sleep(SETTLE)
  const writeA = a.length; const writeB = b.length

  // stopping one must not disturb the other
  a.length = 0; b.length = 0
  if (typeof stopA === 'function') await stopA()
  writeFileSync(file, '2')
  await sleep(SETTLE)
  const afterStopA = a.length; const afterStopB = b.length

  // disposing the fiber must stop the remaining one
  b.length = 0
  if (typeof stopB === 'function') { try { await stopB() } catch {} }
  await fiber.dispose()
  writeFileSync(file, '3')
  await sleep(SETTLE)
  const afterDispose = b.length

  console.log('PROBE262_TWOWATCH ' + JSON.stringify({
    platform: process.platform, node: process.version,
    write: { a: writeA, b: writeB },
    afterStopA: { a: afterStopA, b: afterStopB },
    afterDispose: { b: afterDispose },
  }))
  rmSync(dir, { recursive: true, force: true })
}, 900_000)
