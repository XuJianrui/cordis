import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// How wide is the window, and does proving liveness close it?
//
// The four shapes put the window at (0, 100 ms] after `ready`: a replacement in
// the same instant is never reported, and one 100 ms later always is. Two things
// follow that a rate comparison cannot settle, so both are measured here in one
// job, one arm per question:
//
//   imm        replace at once                       (the case; control)
//   w25/w50/w100  replace after a fixed pause         (where the edge is)
//   sentinel   write a file into the root, wait for that file to be reported,
//              then replace                            (does liveness proof work)
//
// `sentinel` is the candidate that could be implemented in this package: emit
// `ready` only once the watch has been shown to report something, instead of
// when the scan finished. If it reads 0 at the same sample size where `imm`
// reads about 1.5 %, the window is closable from the caller's side.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__fix291__')
const ROUNDS = Number(process.env.FIX_ROUNDS || 120)
const BUDGET = 40

const match = picomatch('linked/**/*.ts', { posix: true })

function contains(a: string, b: string) {
  return !a || b === a || b.startsWith(a + '/')
}

function keep(path: string, isDirectory: boolean) {
  for (let end = path.length; end > 0; end = path.lastIndexOf('/', end - 1)) {
    if (match(path.slice(0, end))) return true
  }
  return isDirectory && (contains('linked', path) || contains(path, 'linked'))
}

function makeIgnored(root: string) {
  const remembered = new Map<string, boolean>()
  return (input: string, stats?: any) => {
    const path = resolve(input)
    if (path === root) return false
    if (stats?.isSymbolicLink()) remembered.delete(path)
    else if (stats) remembered.set(path, stats.isDirectory())
    const isDirectory = remembered.get(path)
    if (isDirectory === undefined) return false
    return !keep(relative(root, path).split(sep).join('/'), isDirectory)
  }
}

type Arm = 'imm' | 'w25' | 'w50' | 'w100' | 'sentinel'

async function round(arm: Arm) {
  const root = resolve(base, `${arm}/relinked/root`)
  const target = resolve(base, `${arm}/relinked/target/file.ts`)
  const link = resolve(root, 'linked')
  const sentinel = resolve(root, 'sentinel.ts')

  rmSync(sentinel, { force: true })
  writeFileSync(target, '')
  rmSync(link, { recursive: true, force: true })
  writeFileSync(link, '')

  const seen: string[] = []
  const raw: string[] = []
  let sentinelSeen = false
  const watcher = watch(root, { ignoreInitial: true, ignored: makeIgnored(root) })
  watcher.on('raw', (event: string, path: string) => raw.push(`${event}:${path}`))
  watcher.on('all', (_event: string, path: string) => {
    if (/file/.test(path)) seen.push(path)
    if (/sentinel/.test(path)) sentinelSeen = true
  })
  await new Promise<void>((done) => watcher.once('ready', () => done()))

  let acked = '-'
  if (arm === 'sentinel') {
    writeFileSync(sentinel, 'x')
    const until = Date.now() + 1000
    while (!sentinelSeen && Date.now() < until) await new Promise(r => setTimeout(r, 5))
    acked = String(sentinelSeen)
    rmSync(sentinel, { force: true })
  } else if (arm !== 'imm') {
    const ms = Number(arm.slice(1))
    await new Promise(r => setTimeout(r, ms))
  }

  rmSync(link, { recursive: true, force: true })
  symlinkSync(dirname(target), link, 'junction')

  let writes = 0
  for (; writes < BUDGET; writes++) {
    if (seen.length) break
    writeFileSync(target, `v${writes}`)
    await new Promise(r => setTimeout(r, 100))
  }

  const keys = Object.keys(watcher.getWatched())
  const hasLink = keys.some((k) => /[\\/]linked$/.test(k) || k === 'linked')
  await watcher.close()

  return { ok: seen.length > 0, writes, raw: raw.length, hasLink, acked }
}

const ARMS: Arm[] = ['imm', 'w25', 'w50', 'w100', 'sentinel']

describe('window width, and whether liveness proof closes it', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    for (const arm of ARMS) {
      mkdirSync(resolve(base, `${arm}/relinked/root`), { recursive: true })
      mkdirSync(resolve(base, `${arm}/relinked/target`), { recursive: true })
    }
  })

  for (const arm of ARMS) {
    for (let index = 0; index < ROUNDS; index++) {
      it(`${arm} ${index}`, async () => {
        const r = await round(arm)
        console.log(`@@FX ${arm} ${index} ${r.ok ? 'pass' : 'timeout'} raw=${r.raw} link=${r.hasLink ? 'L' : 'n'} writes=${r.writes} acked=${r.acked}@@`)
      }, 30000)
    }
  }
})
