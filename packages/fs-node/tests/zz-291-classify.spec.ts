import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { platform, release } from 'node:os'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// What each version does, per round, classified rather than counted.
//
// The last round showed that "did an event arrive" is the wrong question: 6.0.0
// does emit, and names the link instead of the file under it. So every round here
// records which path arrived, whether the link ended up bound, and whether there
// was anything at all — and the arms separate the cases that were being confused:
//
//   imm      file replaced by a link, at once          (the spec's shape)
//   late200  the same, 200 ms later                    (outside the window)
//   retarget a link retargeted to another directory    (never tested before)
//
// `retarget` is the one this repository has no test for. Both versions follow a
// link that exists at `ready`; whether they *re-follow* it after it points
// somewhere else is a different code path, and it is not covered anywhere.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__fm291__')
const ROUNDS = Number(process.env.FM_ROUNDS || 60)
const TAG = `${platform()}-${release().split('.')[0]}-${process.version.slice(1)}`

const match = picomatch('linked/**/*.ts', { posix: true })
function contains(a, b) { return !a || b === a || b.startsWith(a + '/') }
function keepIt(p, isDir) {
  for (let end = p.length; end > 0; end = p.lastIndexOf('/', end - 1)) {
    if (match(p.slice(0, end))) return true
  }
  return isDir && (contains('linked', p) || contains('linked', p))
}

type Arm = 'imm' | 'late200' | 'retarget'

async function round(arm: Arm, i: number) {
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
  if (arm === 'retarget') symlinkSync(a, link, 'junction')
  else writeFileSync(link, '')

  const map = new Map()
  const ignored = (input: string, stats?: any) => {
    const p = resolve(input)
    if (p === root) return false
    if (stats?.isSymbolicLink()) map.delete(p)
    else if (stats) map.set(p, stats.isDirectory())
    const isDir = map.get(p)
    if (isDir === undefined) return false
    return !keepIt(relative(root, p).split(sep).join(posix.sep), isDir)
  }

  const changes: string[] = []
  const adds: string[] = []
  let raw = 0
  const watcher = watch(root, { ignoreInitial: true, ignored })
  watcher.on('raw', () => { raw++ })
  watcher.on('change', (p: string) => changes.push(relative(root, p) || '.'))
  watcher.on('add', (p: string) => adds.push(relative(root, p) || '.'))
  await new Promise<void>((done) => watcher.once('ready', () => done()))

  if (arm === 'late200') await new Promise(r => setTimeout(r, 200))

  const mark = changes.length
  let writeTo = resolve(a, 'file.ts')
  if (arm === 'retarget') {
    rmSync(link, { force: true })
    symlinkSync(b, link, 'junction')
    writeTo = resolve(b, 'file.ts')
  } else {
    rmSync(link, { force: true })
    symlinkSync(a, link, 'junction')
  }

  for (let n = 0; n < 40; n++) {
    if (changes.length > mark) break
    writeFileSync(writeTo, `v${n}`)
    await new Promise(r => setTimeout(r, 100))
  }
  const keys = Object.keys(watcher.getWatched())
  const hasLink = keys.some(k => /[\\/]linked$/.test(k))
  await watcher.close()
  rmSync(home, { recursive: true, force: true }).valueOf?.()
  try { rmSync(home, { recursive: true, force: true }) } catch {}

  const got = changes.slice(mark)
  let kind = 'none'
  if (got.some(c => /file\.ts$/.test(c))) kind = 'file'
  else if (got.length) kind = 'wrong'
  else if (adds.length) kind = 'addonly'
  return { kind, raw, hasLink, adds: adds.length }
}

const ARMS: Arm[] = ['imm', 'late200', 'retarget']

describe('what each version reports, per round', () => {
  beforeAll(() => { rmSync(base, { recursive: true, force: true }) })

  for (const arm of ARMS) {
    for (let i = 0; i < ROUNDS; i++) {
      it(`${arm} ${i}`, async () => {
        const r = await round(arm, i)
        console.log(`@@FM ${TAG} ${arm} ${i} ${r.kind} raw=${r.raw} key=${r.hasLink ? 'y' : 'n'} adds=${r.adds}@@`)
      }, 30000)
    }
  }
})
