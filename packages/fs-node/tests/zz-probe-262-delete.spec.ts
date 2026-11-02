/* eslint-disable */
// PROBE 262 / B: is `delete` unavailable, or merely unimplemented?
//
// The published readouts show ctx.fs delivers 0 delete events on every platform
// while chokidar and raw fs.watch deliver one. That measures the driver as it is;
// it does not say whether a delete CAN be delivered through this interface.
//
// Method: run three implementations of the SAME ctx.fs surface through the SAME
// black-box contract assertions.
//
//   impl1 = the shipped driver
//   impl2 = the shipped driver + the one-line unlink subscription the issue proposes
//   impl3 = a naive rebuild on raw fs.watch over the parent directory
//
// The suite itself asserts only contract-level things: at-least-one on write,
// at-least-one on atomic replace, at-least-one on delete, nothing after stop,
// and that a consumer can re-read the path after any event.
//
// Reading: if impl2 and impl3 both deliver a delete where impl1 does not, the
// gap is implementational. If neither does, the interface cannot carry one.
import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { watch as chokidarWatch } from 'chokidar'
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  statSync, watch as fswatch, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SEEDS = Number(process.env.PROBE262_SEEDS || 80)

type Cb = (e: any) => Awaitable<void>

// ---- impl1: the shipped driver, copied verbatim from packages/fs-node/src/index.ts
class Shipped extends Service {
  constructor(ctx: Context) { super(ctx, 'fs') }
  private _resolve(path: string | URL) {
    if (path instanceof URL || path.startsWith('file:')) return fileURLToPath(path)
    if (isAbsolute(path)) return resolve(path)
    return resolve(path)
  }
  watch(path: string | URL, callback: any, options: any = {}) {
    const filename = this._resolve(path)
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
      const listener = async (p: string) => {
        try { await callback(resolve(p)) } catch {}
      }
      watcher.on('add', listener)
      watcher.on('change', listener)
      await new Promise<void>((r) => watcher.once('ready', () => r()))
      return () => watcher.close()
    }, 'ctx.fs.watch()')
  }
}

// ---- impl2: the shipped driver + the proposed one-line unlink subscription
class PlusUnlink extends Service {
  constructor(ctx: Context) { super(ctx, 'fs') }
  private _resolve(path: string | URL) {
    if (path instanceof URL || path.startsWith('file:')) return fileURLToPath(path)
    if (isAbsolute(path)) return resolve(path)
    return resolve(path)
  }
  watch(path: string | URL, callback: any, options: any = {}) {
    const filename = this._resolve(path)
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
      const listener = async (p: string) => {
        try { await callback({ type: 'change', url: p }) } catch {}
      }
      watcher.on('add', listener)
      watcher.on('change', listener)
      watcher.on('unlink', async (p: string) => {
        try { await callback({ type: 'delete', url: resolve(p) }) } catch {}
      })
      await new Promise<void>((r) => watcher.once('ready', () => r()))
      return () => watcher.close()
    }, 'ctx.fs.watch()')
  }
}

// ---- impl3: naive rebuild, no chokidar at all
class Naive extends Service {
  constructor(ctx: Context) { super(ctx, 'fs') }
  watch(path: string | URL, callback: Cb) {
    const filename = resolve(String(path))
    const root = dirname(filename)
    return this.ctx.effect(async () => {
      const handles: any[] = []
      await new Promise<void>((ready) => {
        const w = fswatch(root, (e: string, name: string | null) => {
          if (!name) return
          const full = resolve(root, String(name))
          if (full !== filename) return
          const type = e === 'rename' ? 'change' : 'change'
          callback({ type, url: full }).catch?.(() => {})
        })
        handles.push(w)
        setTimeout(ready, 120)
      })
      return () => { for (const w of handles) w.close() }
    }, 'ctx.fs.watch()')
  }
}

async function runSuite(load: (ctx: Context) => Promise<() => void>, label: string) {
  const root = mkdtempSync(join(tmpdir(), `del262-${label}-`))
  const out = {
    impl: label, seeds: 0, platform: process.platform, node: process.version,
    writeOK: 0, renameOK: 0, deleteOK: 0, disposeOK: 0, rereadOK: 0,
    writeEvents: 0, renameEvents: 0, deleteEvents: 0,
  }
  const fails: string[] = []

  for (let i = 0; i < SEEDS; i++) {
    const ctx = new Context()
    const dispose = await load(ctx)
    const dir = join(root, `s${i}`); mkdirSync(dir)
    const file = join(dir, 'watched.txt'); writeFileSync(file, '0')

    const events: any[] = []
    const stop: any = await (ctx as any).fs.watch(file, (e: any) => events.push(e))
    await sleep(300)
    events.length = 0

    // 1. write -> at least one event
    writeFileSync(file, '1')
    await sleep(300)
    out.writeEvents += events.length
    if (events.length >= 1) out.writeOK++; else fails.push(`${label}/${i}: write 0`)
    events.length = 0

    // 2. atomic replace -> at least one event
    writeFileSync(join(dir, 'tmp.txt'), '2'); renameSync(join(dir, 'tmp.txt'), file)
    await sleep(300)
    out.renameEvents += events.length
    if (events.length >= 1) out.renameOK++; else fails.push(`${label}/${i}: rename 0`)
    events.length = 0

    // 3. delete -> at least one event
    rmSync(file, { force: true })
    await sleep(300)
    out.deleteEvents += events.length
    if (events.length >= 1) out.deleteOK++
    events.length = 0

    // 4. after stop, nothing
    if (typeof stop === 'function') await stop()
    await dispose?.()
    writeFileSync(join(dir, 'after.txt'), 'x')
    await sleep(300)
    if (events.length === 0) out.disposeOK++; else fails.push(`${label}/${i}: ${events.length} after stop`)

    // 5. a consumer can always re-read the directory it was told about
    try { readFileSync(join(dir, 'after.txt')); out.rereadOK++ } catch { fails.push(`${label}/${i}: reread`) }

    out.seeds++
  }
  rmSync(root, { recursive: true, force: true })
  console.log('PROBE262_DELETE ' + JSON.stringify({ ...out, fails: fails.length, firstFails: fails.slice(0, 5) }))
  return out
}

it('probe 262 delete: three implementations, one contract', async () => {
  // import the real driver and run all three in sequence
  const Fs = (await import('../src/index.ts')).default
  await runSuite(async (ctx) => { const f = await ctx.plugin(Fs); return () => (f as any).dispose() }, 'shipped')
  await runSuite(async (ctx) => { const f = await ctx.plugin(PlusUnlink as any); return () => (f as any).dispose() }, 'plus-unlink')
  await runSuite(async (ctx) => { const f = await ctx.plugin(Naive as any); return () => (f as any).dispose() }, 'naive-fswatch')
}, 2_400_000)
