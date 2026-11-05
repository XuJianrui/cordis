import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// The same case as `zz-291-nofilter.spec.ts`, with the one difference that
// decides the question: the `ignored` predicate this package supplies.
//
// The predicate is a copy of the one on main — same rules, same remembered
// type — so the comparison isolates the predicate and nothing else.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__wf291__')
const root = resolve(fixture, 'relinked/root')
const target = resolve(fixture, 'relinked/target/file.ts')
const link = resolve(root, 'linked')
const ROUNDS = 40
const BUDGET = 40

const pattern = posixNormalize('linked/**/*.ts')
const match = picomatch(pattern, { posix: true })

function posixNormalize(entry: string) {
  const negated = entry.startsWith('!')
  return (negated ? entry.slice(1) : entry).replace(/\/$/, '')
}

function contains(base: string, path: string) {
  return !base || path === base || path.startsWith(base + '/')
}

// `matchesUpward` as `toPredicate` implements it: the pattern is tested against
// the path and every ancestor of it
function matchesUpward(path: string) {
  for (let end = path.length; end > 0; end = path.lastIndexOf('/', end - 1)) {
    if (match(path.slice(0, end))) return true
  }
  return false
}

// `toPredicate(['linked/**/*.ts'])`: the pattern decides, and a directory is
// also kept when an including pattern may lead below it. A *file* named
// `linked` is not kept — only the directory is.
function keep(path: string, isDirectory: boolean) {
  if (matchesUpward(path)) return true
  return isDirectory && (contains('linked', path) || contains(path, 'linked'))
}

// the predicate on main: a type remembered from an earlier call answers a call
// that carries no stats
function makeIgnored() {
  const isDirectoryMap = new Map<string, boolean>()
  return (input: string, stats?: any) => {
    const path = resolve(input)
    if (path === root) return false
    if (stats?.isSymbolicLink()) isDirectoryMap.delete(path)
    else if (stats) isDirectoryMap.set(path, stats.isDirectory())
    const isDirectory = isDirectoryMap.get(path)
    if (isDirectory === undefined) return false
    return !keep(relative(root, path).split(sep).join('/'), isDirectory)
  }
}

async function touch(path: string, cond: () => unknown) {
  for (let i = 0; i < BUDGET; i++) {
    if (cond()) return true
    writeFileSync(path, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
  return !!cond()
}

describe('relink, watch layer alone, with the predicate', () => {
  beforeAll(() => {
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    mkdirSync(root, { recursive: true })
  })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      writeFileSync(target, '')
      rmSync(link, { recursive: true, force: true })
      writeFileSync(link, '')

      const seen: string[] = []
      const watcher = watch(root, { ignoreInitial: true, ignored: makeIgnored() })
      watcher.on('all', (_event, path) => seen.push(path))
      await new Promise<void>((done) => watcher.once('ready', () => done()))

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      const ok = await touch(target, () => seen.length)
      await watcher.close()
      console.log(`@@WF ${index} ${ok ? 'pass' : 'timeout'} n=${seen.length}@@`)
    }, 20000)
  }
})
