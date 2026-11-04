// Local adjudication probes for rows 7c / 7d / 5c.
//
// These are prototypes + mechanism checks, not CI evidence:
//   - 7c/7d use the REAL ctx.fs.watch handle from fs-node, wrapped as an async
//     iterator. They show the wrapper semantics (break stops, stop settles a
//     pending next) on top of the real driver; they do not claim the driver
//     already exposes an iterator.
//   - 5c uses node:fs/promises readFile with AbortSignal. ctx.fs.readFile does
//     not exist, so this is the mechanism the interface would delegate to.
import { describe, it, expect, afterAll } from 'vitest'
import { Context } from '../../core/src/index.ts'
import Fs from '../src/index.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// chokidar needs the file to actually look changed: a fresh write, a different
// length, and a moment between writes. On ext4 a write of the same length within
// the same mtime tick can be coalesced and delivered as zero events. Write first,
// then give the watcher time; the old version slept before writing and timed the
// wait from the loop counter, so its own 8 s budget fired on time, not on silence.
async function touchUntil(
  path: string,
  cond: () => boolean,
  countRaw: () => number,
  timeout = 15_000,
) {
  const start = Date.now()
  for (let i = 0; !cond(); i++) {
    const elapsed = Date.now() - start
    if (elapsed >= timeout) {
      throw new Error(
        `touch timed out after ${elapsed} ms, ${i} writes, raw=${countRaw()}`,
      )
    }
    const t1 = Date.now()
    // Isolate the write. If it hangs, say so; do not let the outer "touch"
    // timeout take the blame, because the outer loop also waits on cond().
    const writeOutcome = await Promise.race([
      writeFile(path, `v${i}` + 'x'.repeat(i % 64)).then(() => 'ok'),
      new Promise<string>((resolve) => setTimeout(() => resolve('write-hung'), 5000)),
    ])
    const writeMs = Date.now() - t1
    console.log('ADJ_ITER_WRITE =', JSON.stringify({ i, ms: writeMs, result: writeOutcome, raw: countRaw() }))
    if (writeOutcome !== 'ok') {
      throw new Error(`writeFile never returned at i=${i} (${writeMs} ms)`)
    }
    await sleep(150)
  }
}

type Iter = AsyncIterableIterator<string>

function makeIterator(register: (cb: (p: string) => void) => Promise<() => void>) {
  const queue: string[] = []
  let pending: ((r: IteratorResult<string>) => void) | undefined
  let stopped = false
  let stopFn: (() => void) | undefined
  let rawCallbacks = 0
  let afterStopCallbacks = 0

  const ready = register((p) => {
    rawCallbacks++
    // Log what the driver actually hands over, before any filtering above it.
    // If `p` is not byte-identical to the registered name on some platform,
    // the wrapper would swallow it and the failure would look like "no event".
    if (rawCallbacks <= 24) {
      console.log('ADJ_ITER_RAW_PATH =', JSON.stringify(p))
    }
    if (stopped) {
      afterStopCallbacks++
      return
    }
    if (pending) {
      const r = pending
      pending = undefined
      r({ value: p, done: false })
    } else {
      queue.push(p)
    }
  }).then((stop) => {
    stopFn = stop
    return stop
  })

  const iter: Iter = {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false })
      if (stopped) return Promise.resolve({ value: undefined as any, done: true })
      return new Promise((resolve) => {
        pending = resolve
      })
    },
    return() {
      stopped = true
      stopFn?.()
      if (pending) {
        const r = pending
        pending = undefined
        r({ value: undefined as any, done: true })
      }
      return Promise.resolve({ value: undefined as any, done: true })
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }

  return {
    iter,
    ready,
    stats: () => ({ rawCallbacks, afterStopCallbacks, queue: queue.length, hasPending: !!pending }),
    stop: () => stopFn?.(),
  }
}

async function nextWithTimeout(iter: Iter, ms: number): Promise<any> {
  return Promise.race([
    iter.next(),
    sleep(ms).then(() => ({ timeout: true })),
  ])
}

describe('adjudication prototypes (local, not CI)', () => {
  let readyStateReport = 'not-reached'
  afterAll(() => {
    // Survives log truncation: if the test times out or the job is killed,
    // this line still says whether watch() settled, and how.
    console.log('ADJ_ITER_READY_STATE_FINAL =', readyStateReport)
  })

  it('7c/7d: break stops delivery; stop settles a pending next()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe262-iter-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'v0')
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')

    try {
      // --- first watcher: event delivery + break ---
      const t0 = Date.now()
      const a = makeIterator((cb) => fs.watch(file, cb))
      const readyState = await Promise.race([
        a.ready.then((stop) => ({ state: 'resolved', stop })),
        sleep(10_000).then(() => ({ state: 'hung' })),
      ]).catch((e) => ({ state: 'rejected', error: String(e) }))
      console.log('ADJ_ITER_READY_STATE =', JSON.stringify({ state: readyState.state }))
      readyStateReport = readyState.state
      if (readyState.state !== 'resolved') {
        throw new Error(`watch() never became ready: ${readyState.state}`)
      }
      console.log('ADJ_ITER_READY_MS =', Date.now() - t0)

      // A single write right after `await watch` can land before the OS watch
      // is established (Linux inotify needs a moment). Write until the driver
      // reports a callback, the same way tests/index.spec.ts does; otherwise
      // the probe reads its own timing as a platform difference.
      await touchUntil(file, () => a.stats().raw > 0, () => a.stats().raw)
      // Snapshot the wrapper's internal state at the moment the wait ends.
      // If raw > 0 but the event never reaches next(), the defect is in here.
      console.log('ADJ_ITER_SNAPSHOT =', JSON.stringify(a.stats()))
      const first = await nextWithTimeout(a.iter, 4000)
      console.log('ADJ_ITER_FIRST =', JSON.stringify(first))

      await a.iter.return!()
      const before = a.stats().afterStopCallbacks
      // Write a *different* name: the driver filters by the registered
      // spelling, so this can only arrive if stop() failed, not if a
      // same-path event was already in flight when return() was called.
      writeFileSync(join(dir, 'after-stop.txt'), 'x')
      writeFileSync(file, 'after-stop')
      await sleep(800)
      const after = a.stats().afterStopCallbacks
      console.log('ADJ_ITER_AFTER_STOP_CALLBACKS =', after - before)
      console.log('ADJ_ITER_STATS =', JSON.stringify(a.stats()))

      // --- second watcher: pending next settles on stop ---
      const b = makeIterator((cb) => fs.watch(file, cb))
      await b.ready
      const pending = b.iter.next()
      await sleep(600)
      await b.iter.return!()
      const settled = await Promise.race([
        pending.then((r) => ({ resolved: true, done: r.done })),
        sleep(1500).then(() => ({ resolved: false })),
      ])
      console.log('ADJ_ITER_PENDING_SETTLED =', JSON.stringify(settled))

      expect(first.timeout).toBeUndefined()
      expect(typeof first.value).toBe('string')
      expect(settled).toEqual({ resolved: true, done: true })
      expect(after - before).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('5c: node readFile honours AbortSignal (mechanism check)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe262-abort-'))
    const file = join(dir, 'big.bin')
    writeFileSync(file, Buffer.alloc(32 * 1024 * 1024, 0x61))
    try {
      const controlStart = Date.now()
      await readFile(file)
      console.log('ADJ_ABORT_CONTROL_MS =', Date.now() - controlStart)

      for (let i = 0; i < 5; i++) {
        const t = Date.now()
        let name = 'NO ERROR'
        let code = ''
        try {
          await readFile(file, { signal: AbortSignal.timeout(1) })
        } catch (e: any) {
          name = e?.name ?? 'unknown'
          code = e?.code ?? ''
        }
        console.log(`ADJ_ABORT_TRIAL_${i} =`, JSON.stringify({ name, code, ms: Date.now() - t }))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})