import { Context } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { platform, release } from 'node:os'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Fs from '../src/index.ts'

// The full matrix through the real `ctx.fs.watch`, which is the only entry point this
// repository's consumers use.
//
// Everything measured before this file was taken through a hand-written chokidar wrapper whose
// `ignored` callback approximated `toPredicate`. That approximation is not the code under test,
// and the readings could not have distinguished a fault in the library from a fault in the
// approximation. This file removes the middleman.
//
// Four dimensions:
//
//   what is passed to watch()   the link itself   |   the directory holding it
//   the transition              link retargeted   |   link replaced by a real directory
//                               plain file → link |   baseline: target written, link untouched
//   the filter                  none   |   the alias (`linked/**`)   |   everything (`**/*.ts`)
//   where the target lives      beside the root (never directly watched) — always, this run
//
// The target is always outside the watched tree. A target inside it would be seen directly and
// would make a broken link look like a working one.
//
// Two rounds per cell; a cell that ever sees the write is reported as seen, and the counts are
// printed so a 1-of-2 cannot be read as a pass.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__matrix__')
const TAG = `${platform()}-${release().split('.')[0]}-${process.version.slice(1)}`
const ROUNDS = 2

let fiber: any

beforeAll(() => {
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  fiber = new Context().plugin(Fs)
})
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

type When = 'retarget' | 'link2dir' | 'file2link' | 'file2dir' | 'baseline' | 'retargetLate' | 'rewatch' | 'retargetTwice' | 'rewatchThenRetarget'
type Passed = 'link' | 'parent'

async function cell(when: When, passed: Passed, filter: 'none' | 'alias' | 'all') {
  const home = resolve(base, `${when}-${passed}-${filter}-${Math.random().toString(36).slice(2)}`)
  const root = resolve(home, 'root')
  const a = resolve(home, 'a')
  const b = resolve(home, 'b')
  for (const d of [root, a, b]) mkdirSync(d, { recursive: true })
  writeFileSync(resolve(a, 'file.ts'), 'v0')
  writeFileSync(resolve(b, 'file.ts'), 'v0')
  const link = resolve(root, 'linked')

  // the state of the entry when the watch is created
  if (when === 'file2link' || when === 'file2dir') writeFileSync(link, '')
  else symlinkSync(a, link, 'junction')

  const options: any = {}
  if (filter === 'alias') options.filter = ['linked/**/*.ts']
  if (filter === 'all') options.filter = ['**/*.ts']

  const seen: string[] = []
  const target = passed === 'link' ? link : root
  let w = fiber.ctx.fs.watch(target, options)
  // the listener is registered with on(), not passed to watch()
  w.on('change', (f: string) => { seen.push(relative(root, f) || '.') })
  await new Promise<void>(r => w.on('ready', () => r()))
  const mark = seen.length

  // the transition, and where the writes go afterwards
  let writeTo = resolve(b, 'file.ts')
  if (when === 'retarget') {
    rmSync(link, { recursive: true, force: true })
    symlinkSync(b, link, 'junction')
  } else if (when === 'link2dir') {
    rmSync(link, { recursive: true, force: true })
    mkdirSync(link, { recursive: true })
    writeTo = resolve(link, 'file.ts')
  } else if (when === 'file2link') {
    rmSync(link, { recursive: true, force: true })
    symlinkSync(a, link, 'junction')
    writeTo = resolve(a, 'file.ts')
  } else if (when === 'file2dir') {
    rmSync(link, { recursive: true, force: true })
    mkdirSync(link, { recursive: true })
    writeTo = resolve(link, 'file.ts')
  } else if (when === 'retargetLate') {
    // the user's timing: the link is repointed, then the target is written a second later
    rmSync(link, { recursive: true, force: true })
    symlinkSync(b, link, 'junction')
    await new Promise(r => setTimeout(r, 1000))
    writeTo = resolve(b, 'file.ts')
  } else if (when === 'retargetTwice') {
    // repoint, then repoint again — a deployment that switches versions twice
    rmSync(link, { recursive: true, force: true })
    symlinkSync(b, link, 'junction')
    await new Promise(r => setTimeout(r, 300))
    rmSync(link, { recursive: true, force: true })
    symlinkSync(a, link, 'junction')
    await new Promise(r => setTimeout(r, 300))
    writeTo = resolve(a, 'file.ts')
  } else if (when === 'rewatchThenRetarget') {
    // recover once, then repoint again: does the workaround keep working
    rmSync(link, { recursive: true, force: true })
    symlinkSync(b, link, 'junction')
    await w.dispose()
    w = fiber.ctx.fs.watch(target, options)
    w.on('change', (f: string) => { seen.push(relative(root, f) || '.') })
    await new Promise<void>(r => w.on('ready', () => r()))
    rmSync(link, { recursive: true, force: true })
    symlinkSync(a, link, 'junction')
    writeTo = resolve(a, 'file.ts')
  } else if (when === 'rewatch') {
    // the workaround a user would reach for: dispose and watch again after repointing
    rmSync(link, { recursive: true, force: true })
    symlinkSync(b, link, 'junction')
    await w.dispose()
    w = fiber.ctx.fs.watch(target, options)
    w.on('change', (f: string) => { seen.push(relative(root, f) || '.') })
    await new Promise<void>(r => w.on('ready', () => r()))
    writeTo = resolve(b, 'file.ts')
  } else {
    writeTo = resolve(a, 'file.ts')
  }

  for (let i = 0; i < 15; i++) {
    if (seen.length > 0) break
    writeFileSync(writeTo, `v${i + 1}`)
    await new Promise(r => setTimeout(r, 100))
  }
  await w.dispose()
  try { rmSync(home, { recursive: true, force: true }) } catch {}
  return seen.slice(mark)
}

const WHEN: When[] = ['baseline', 'retarget', 'link2dir', 'file2link', 'file2dir', 'retargetLate', 'rewatch', 'retargetTwice', 'rewatchThenRetarget']
const PASSED: Passed[] = ['link', 'parent']
const FILTERS: Array<'none' | 'alias' | 'all'> = ['none', 'alias', 'all']

describe(`the matrix through the real watcher (${TAG})`, () => {
  for (const when of WHEN) {
    for (const passed of PASSED) {
      for (const filter of FILTERS) {
        it(`${when} ${passed} ${filter}`, async () => {
          const outs: string[][] = []
          for (let i = 0; i < ROUNDS; i++) outs.push(await cell(when, passed, filter))
          const ok = outs.filter(o => o.length > 0).length
          const sample = outs.find(o => o.length) || []
          console.log(`@@MX ${TAG} ${when} ${passed} ${filter} ${ok}/${ROUNDS} ${JSON.stringify(sample.slice(0, 2))}@@`)
        }, 180000)
      }
    }
  }
})
