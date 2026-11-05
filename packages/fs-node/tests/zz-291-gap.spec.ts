import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// How long is the gap, and who creates it?
//
// The case is the spec's. A round that reports nothing for its whole 4 s budget
// is a failure; only then, and only there, is the round kept open and probed
// further, because anything done to every round changes the rate (a per-round
// ping made 1200 rounds clean, at about 3e-7).
//
// After a failure the round keeps going for up to 30 s, writing two things each
// 100 ms:
//
//   a fresh file in the root      -> is the root's own watch reporting again?
//   another write to the target   -> does a watch on the link path ever arrive?
//
// Both times are measured from the moment the round was declared a failure, so:
//
//   gapRoot short, gapLink never   the root recovers; the link never gets a watch
//   gapRoot short, gapLink short   both recover: a window, not a defect
//   gapRoot never                  the root watch is gone for good
//
// The durations separate the candidates that a rate comparison cannot:
// about 1 s points at a readdir throttle, several seconds at a stream reset,
// and `never` at a registration that was never made.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__gap291__')
const ROUNDS = Number(process.env.GAP_ROUNDS || 150)
const BUDGET = 40
const WATCH_WINDOW = 30000
const STEP = 100

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

function bound(watcher: { getWatched(): Record<string, string[]> }) {
  const keys = Object.keys(watcher.getWatched())
  return { count: keys.length, hasLink: keys.some((k) => /[\\/]linked$/.test(k) || k === 'linked') }
}

describe('how long is the gap after a replacement', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(resolve(base, 'relinked/root'), { recursive: true })
    mkdirSync(resolve(base, 'relinked/target'), { recursive: true })
  })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      const root = resolve(base, 'relinked/root')
      const target = resolve(base, 'relinked/target/file.ts')
      const link = resolve(root, 'linked')

      writeFileSync(target, '')
      rmSync(link, { recursive: true, force: true })
      writeFileSync(link, '')

      const raw: string[] = []
      const seen: string[] = []
      const watcher = watch(root, { ignoreInitial: true, ignored: makeIgnored(root) })
      watcher.on('raw', (event: string, path: string) => raw.push(`${event}:${path}`))
      watcher.on('all', (_event: string, path: string) => { if (/file/.test(path)) seen.push(path) })
      await new Promise<void>((done) => watcher.once('ready', () => done()))
      const before = bound(watcher)

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      let writes = 0
      for (; writes < BUDGET; writes++) {
        if (seen.length) break
        writeFileSync(target, `v${writes}`)
        await new Promise(r => setTimeout(r, STEP))
      }
      const afterRound = bound(watcher)
      const rawInRound = raw.length

      if (seen.length) {
        await watcher.close()
        console.log(`@@GP ${index} pass rawInRound=${rawInRound} before=${before.count}/${before.hasLink ? 'L' : 'n'} after=${afterRound.count}/${afterRound.hasLink ? 'L' : 'n'}@@`)
        return
      }

      // the round failed: keep it open and see which watch comes back, and when
      const rawBefore = raw.length
      const seenBefore = seen.length
      const pings: string[] = []
      let gapRoot = -1
      let gapLink = -1
      const started = Date.now()
      const after = bound(watcher)

      for (let i = 0; i * STEP < WATCH_WINDOW; i++) {
        writeFileSync(target, `w${i}`)
        const ping = resolve(root, `ping-${i}.ts`)
        pings.push(ping)
        writeFileSync(ping, 'x')
        await new Promise(r => setTimeout(r, STEP))
        const elapsed = Date.now() - started
        if (gapRoot < 0 && raw.length > rawBefore && raw.slice(rawBefore).some((s) => /ping/.test(s))) {
          gapRoot = elapsed
        }
        if (gapLink < 0 && seen.length > seenBefore) {
          gapLink = elapsed
        }
        if (gapRoot >= 0 && gapLink >= 0) break
      }

      const afterProbe = bound(watcher)
      await watcher.close()
      for (const ping of pings) rmSync(ping, { force: true })

      console.log(
        `@@GP ${index} timeout rawInRound=${rawInRound} before=${before.count}/${before.hasLink ? 'L' : 'n'}` +
        ` after=${after.count}/${after.hasLink ? 'L' : 'n'}` +
        ` afterProbe=${afterProbe.count}/${afterProbe.hasLink ? 'L' : 'n'}` +
        ` gapRoot=${gapRoot} gapLink=${gapLink} writes=${writes}@@`,
      )
    }, 60000)
  }
})
