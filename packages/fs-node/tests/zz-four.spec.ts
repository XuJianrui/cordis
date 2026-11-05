import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { platform, release } from 'node:os'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// Four transitions, one instrument, every platform.
//
// The previous runs measured `retarget` and `link2dir` with this instrument and found
// 4.0.3 failing everywhere while 6.0.0 passed — the opposite of what a looser probe had
// suggested. The two transitions that matter for the other report were never measured
// this way, so they are added here and all four run in one job:
//
//   file2link  a plain file becomes a link to a directory   (the spec's shape)
//   file2dir   a plain file becomes a real directory
//   retarget   a link is pointed at another directory
//   link2dir   a link becomes a real directory
//
// The predicate is a verbatim copy of the one `packages/fs-node/src/watcher.ts`
// supplies, and every call is logged with whether it carried stats and what it
// decided, so filtering can be ruled in or out rather than assumed.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__four__')
const ROUNDS = Number(process.env.FOUR_ROUNDS || 12)
const TAG = `${platform()}-${release().split('.')[0]}-${process.version.slice(1)}`

const match = picomatch('linked/**/*.ts', { posix: true })
function contains(a: string, b: string) { return !a || b === a || b.startsWith(a + '/') }
function keepByFilter(rel: string, isDir: boolean) {
  for (let end = rel.length; end > 0; end = rel.lastIndexOf('/', end - 1)) {
    if (match(rel.slice(0, end))) return true
  }
  return isDir && (contains('linked', rel) || contains(rel, 'linked'))
}

function predicate(root: string, log: string[]) {
  const map = new Map<string, boolean>()
  return (input: string, stats?: any) => {
    const p = resolve(input)
    const rel = relative(root, p).split(sep).join(posix.sep) || '.'
    if (p === root) { log.push(`${rel}[root]keep`); return false }
    if (stats?.isSymbolicLink()) map.delete(p)
    else if (stats) map.set(p, stats.isDirectory())
    const isDirectory = map.get(p)
    const kind = stats ? (stats.isDirectory() ? 'dir' : stats.isSymbolicLink() ? 'lnk' : 'file') : 'nostats'
    if (isDirectory === undefined) { log.push(`${rel}[${kind}]keep(unk)`); return false }
    const verdict = !keepByFilter(rel, isDirectory)
    log.push(`${rel}[${kind}]${verdict ? 'IGNORE' : 'keep'}`)
    return verdict
  }
}

function snap(w: any, root: string) {
  try {
    const o = w.getWatched()
    return Object.keys(o)
      .map(k => `${relative(root, k) || '.'}:${(o[k] || []).length}`)
      .sort().join(' ')
  } catch { return '(threw)' }
}

async function round(arm: string, i: number) {
  const home = resolve(base, `${arm}/${i}`)
  const root = resolve(home, 'root')
  const a = resolve(home, 'a')
  const b = resolve(home, 'b')
  mkdirSync(root, { recursive: true })
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  writeFileSync(resolve(a, 'file.ts'), 'v0')
  writeFileSync(resolve(b, 'file.ts'), 'v0')
  const link = resolve(root, 'linked')

  // the state of the entry when the scan runs
  if (arm === 'file2link' || arm === 'file2dir') writeFileSync(link, '')
  else symlinkSync(a, link, 'junction')

  const log: string[] = []
  const events: string[] = []
  const errors: string[] = []
  const w = watch(root, { ignoreInitial: true, ignored: predicate(root, log) })
  w.on('all', (e: string, p: string) => events.push(`${e}:${relative(root, p) || '.'}`))
  w.on('error', (e: any) => errors.push(e?.code || 'err'))
  await new Promise<void>((done) => w.once('ready', () => done()))

  const before = snap(w, root)
  const scanCalls = log.length
  const mark = events.length

  let writeTo = ''
  if (arm === 'file2link') {
    rmSync(link, { recursive: true, force: true })
    symlinkSync(a, link, 'junction')
    writeTo = resolve(a, 'file.ts')
  } else if (arm === 'file2dir' || arm === 'link2dir') {
    rmSync(link, { recursive: true, force: true })
    mkdirSync(link, { recursive: true })
    writeTo = resolve(link, 'file.ts')
  } else {
    rmSync(link, { recursive: true, force: true })
    symlinkSync(b, link, 'junction')
    writeTo = resolve(b, 'file.ts')
  }

  for (let n = 0; n < 20; n++) {
    if (events.length > mark) break
    writeFileSync(writeTo, `v${n + 1}`)
    await new Promise(r => setTimeout(r, 100))
  }

  const after = snap(w, root)
  await w.close()
  try { rmSync(home, { recursive: true, force: true }) } catch {}

  const got = events.slice(mark)
  const verdict = got.some(e => /linked[\\/].*file\.ts$/.test(e)) ? 'file'
    : got.some(e => /:linked$/.test(e)) ? 'self'
    : got.length ? 'other' : 'none'
  const calls = log.slice(scanCalls)
  const ignored = calls.filter(c => c.endsWith('IGNORE')).length

  console.log(
    `@@FV ${TAG} ${arm} ${i} ${verdict}` +
    ` ev=${got.length ? got.slice(0, 2).join(',') : '-'}` +
    ` ig=${ignored}/${calls.length}` +
    ` keys=${before}->${after} err=${errors[0] || '-'}@@`,
  )
}

const ARMS = ['file2link', 'file2dir', 'retarget', 'link2dir']

describe('four transitions of the watched entry, every platform', () => {
  beforeAll(() => { rmSync(base, { recursive: true, force: true }) })
  for (const arm of ARMS) {
    for (let i = 0; i < ROUNDS; i++) {
      it(`${arm} ${i}`, async () => { await round(arm, i) }, 40000)
    }
  }
})
