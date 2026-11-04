// Run the backend-agnostic watch contract against the REAL fs-node driver.
//
// The adapter declares today's capabilities honestly:
//   delete: false    - the driver does not subscribe to unlink
//   reResolve: false - a watch on a missing path keeps the file shape
// The suite then checks WRITE, STOP and ITERATOR, and reports DELETE/RERESOLVE
// as skipped. This is the "the contract runs against a real backend" half; the
// The harness is inlined below so this file has no dependency outside packages/.
import { describe, it, expect } from 'vitest'
import { Context } from '../../core/src/index.ts'
import Fs from '../src/index.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// A backend-agnostic conformance harness for the watch contract.
//
// The harness knows only this interface:
//   capabilities: { delete: boolean, reResolve: boolean }
//   fixture(name)                         -> { url, cleanup() }
//   watch(url, onEvent)                   -> Promise<stop>
//   write(url, content)                   -> Promise<void>
//   remove(url)                           -> Promise<void>
//   mkdir(url)                            -> Promise<void>   (only for reResolve)
//
// onEvent receives { type: 'create' | 'change' | 'delete', url }.
//
// It imports nothing from node:fs and nothing from cordis, so a backend can be
// an in-memory map, OPFS, an object store, or the real driver behind an adapter.
// A backend that cannot do a thing declares it in capabilities; the suite skips
// that check rather than pretending it passed.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (cond()) return true
    await sleep(25)
  }
  return cond()
}

function makeIterator(register) {
  const queue = []
  let pending
  let stopped = false
  let stopFn
  let afterStop = 0
  let raw = 0

  const ready = register((event) => {
    raw++
    if (stopped) {
      afterStop++
      return
    }
    if (pending) {
      const r = pending
      pending = undefined
      r({ value: event, done: false })
    } else {
      queue.push(event)
    }
  }).then((stop) => {
    stopFn = stop
    return stop
  })

  const iter = {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
      if (stopped) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve) => { pending = resolve })
    },
    return() {
      stopped = true
      stopFn?.()
      if (pending) {
        const r = pending
        pending = undefined
        r({ value: undefined, done: true })
      }
      return Promise.resolve({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() { return this },
  }

  return { iter, ready, stats: () => ({ raw, afterStop }) }
}

async function runContract(backend, { log = console.log, timeout = 3000 } = {}) {
  const results = []
  const record = (name, ok, detail, skipped = false) => {
    results.push({ name, ok, skipped, detail })
    log(`CONF_${name} = ${skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL'}${detail ? ' ' + detail : ''}`)
  }

  // 1. A write delivers at least one event.
  {
    const { url, cleanup } = backend.fixture('write')
    const events = []
    const stop = await backend.watch(url, (e) => events.push(e))
    await backend.write(url, 'v1')
    const got = await waitFor(() => events.length > 0, timeout)
    record('WRITE', got, `events=${events.length}`)
    stop()
    cleanup()
  }

  // 2. Nothing arrives after stop.
  {
    const { url, cleanup } = backend.fixture('stop')
    let after = 0
    let stopped = false
    const events = []
    const stop = await backend.watch(url, (e) => {
      if (stopped) after++
      else events.push(e)
    })
    await backend.write(url, 'v1')
    await waitFor(() => events.length > 0, timeout)
    stopped = true
    stop()
    await backend.write(url, 'v2')
    await sleep(200)
    record('STOP', after === 0, `after=${after}`)
    cleanup()
  }

  // 3. A delete is a delete event, when the backend claims it can report one.
  if (backend.capabilities.delete) {
    const { url, cleanup } = backend.fixture('delete')
    const events = []
    const stop = await backend.watch(url, (e) => events.push(e))
    await backend.write(url, 'v1')
    await waitFor(() => events.length > 0, timeout)
    await backend.remove(url)
    const got = await waitFor(() => events.some((e) => e.type === 'delete'), timeout)
    record('DELETE', got, `types=${events.map((e) => e.type).join(',')}`)
    stop()
    cleanup()
  } else {
    record('DELETE', true, 'capability=false', true)
  }

  // 4. A later directory is delivered when the backend claims re-resolution.
  if (backend.capabilities.reResolve) {
    const { url, cleanup } = backend.fixture('reresolve')
    const events = []
    const stop = await backend.watch(url, (e) => events.push(e))
    await backend.mkdir(url)
    await backend.write(url + '/child.txt', 'v1')
    const got = await waitFor(() => events.length > 0, timeout)
    record('RERESOLVE', got, `events=${events.length}`)
    stop()
    cleanup()
  } else {
    record('RERESOLVE', true, 'capability=false', true)
  }

  // 5. Iterator wrapper: break stops, and stop settles a pending next().
  {
    const { url, cleanup } = backend.fixture('iterator')
    const a = makeIterator((cb) => backend.watch(url, cb))
    await a.ready
    await backend.write(url, 'v1')
    const first = await Promise.race([
      a.iter.next(),
      sleep(timeout).then(() => ({ timeout: true })),
    ])
    await a.iter.return()
    const before = a.stats().afterStop
    await backend.write(url, 'v2')
    await sleep(200)
    const afterBreak = a.stats().afterStop - before

    const b = makeIterator((cb) => backend.watch(url, cb))
    await b.ready
    const pending = b.iter.next()
    await sleep(50)
    await b.iter.return()
    const settled = await Promise.race([
      pending.then((r) => ({ resolved: true, done: r.done })),
      sleep(1000).then(() => ({ resolved: false })),
    ])

    const ok = !first.timeout && afterBreak === 0 && settled.resolved && settled.done
    record('ITERATOR', ok, `first=${JSON.stringify(first)} afterBreak=${afterBreak} settled=${JSON.stringify(settled)}`)
    cleanup()
  }

  return results
}

describe('conformance: the watch contract through the real driver', () => {
  it('passes the suite for its declared capabilities', async () => {
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')
    const root = mkdtempSync(join(tmpdir(), 'probe262-conf-'))
    let id = 0

    const backend = {
      capabilities: { delete: false, reResolve: false },
      fixture(name: string) {
        const dir = join(root, `${name}-${id++}`)
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'a.txt')
        writeFileSync(file, 'v0')
        return {
          url: pathToFileURL(file).href,
          cleanup() {
            rmSync(dir, { recursive: true, force: true })
          },
        }
      },
      async watch(url: string, onEvent: (e: any) => void) {
        return fs.watch(url, (p: string) => onEvent({ type: 'change', url: p }))
      },
      async write(url: string, content: string) {
        writeFileSync(fileURLToPath(url), content)
      },
      async remove(url: string) {
        rmSync(fileURLToPath(url))
      },
      async mkdir(url: string) {
        mkdirSync(fileURLToPath(url), { recursive: true })
      },
    }

    try {
      const results = await runContract(backend, {
        log: (line: string) => console.log(line),
        timeout: 8000,
      })
      const failed = results.filter((r: any) => !r.ok)
      expect(failed).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})