import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'

// Four shapes in one job, so the machine, the load and the moment are shared.
// The question is what the drop needs: a write, a link, or the replacement.
//
//   plain    a file directly in the watched directory, never replaced
//   link     a link present from the first round, written through, never replaced
//   relink   the same link, removed and recreated once per round
//   minimal  the stand-alone reproduction exactly as the report writes it
//
// If `plain` also goes silent, the drop has nothing to do with links or with
// replacement, and the framing of the whole case is wrong.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__shape291__')
const ROUNDS = 40
const BUDGET = 40

const plainDir = resolve(base, 'plain')
const plainFile = resolve(plainDir, 'file.ts')

const linkRoot = resolve(base, 'link/root')
const linkTarget = resolve(base, 'link/target')
const linkFile = resolve(linkTarget, 'file.ts')
const linkPath = resolve(linkRoot, 'linked')

const relinkRoot = resolve(base, 'relink/root')
const relinkTarget = resolve(base, 'relink/target')
const relinkFile = resolve(relinkTarget, 'file.ts')
const relinkPath = resolve(relinkRoot, 'linked')

const minRoot = resolve(base, 'min/root')
const minTarget = resolve(base, 'min/target')
const minFile = resolve(minTarget, 'file.ts')
const minPath = resolve(minRoot, 'linked')

async function writes(path: string, seen: () => number, budget: number) {
  for (let i = 0; i < budget; i++) {
    if (seen() > 0) return true
    writeFileSync(path, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
  return seen() > 0
}

function open(root: string, options: Record<string, unknown> = {}) {
  const seen: string[] = []
  const watcher = watch(root, { ignoreInitial: true, ...options })
  watcher.on('all', (_event: string, path: string) => seen.push(path))
  return { watcher, seen }
}

describe('shape', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    for (const dir of [plainDir, linkRoot, linkTarget, relinkRoot, relinkTarget, minRoot, minTarget]) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(linkFile, '')
    symlinkSync(linkTarget, linkPath, 'junction')
  })

  for (let i = 0; i < ROUNDS; i++) {
    it(`plain ${i}`, async () => {
      writeFileSync(plainFile, '')
      const { watcher, seen } = open(plainDir)
      await new Promise<void>((done) => watcher.once('ready', () => done()))
      const ok = await writes(plainFile, () => seen.length, BUDGET)
      await watcher.close()
      console.log(`@@SH plain ${i} ${ok ? 'pass' : 'timeout'} n=${seen.length}@@`)
    }, 20000)
  }

  for (let i = 0; i < ROUNDS; i++) {
    it(`link ${i}`, async () => {
      writeFileSync(linkFile, '')
      const { watcher, seen } = open(linkRoot)
      await new Promise<void>((done) => watcher.once('ready', () => done()))
      const ok = await writes(linkFile, () => seen.length, BUDGET)
      await watcher.close()
      console.log(`@@SH link ${i} ${ok ? 'pass' : 'timeout'} n=${seen.length}@@`)
    }, 20000)
  }

  for (let i = 0; i < ROUNDS; i++) {
    it(`relink ${i}`, async () => {
      writeFileSync(relinkFile, '')
      rmSync(relinkPath, { recursive: true, force: true })
      writeFileSync(relinkPath, '')
      const { watcher, seen } = open(relinkRoot)
      await new Promise<void>((done) => watcher.once('ready', () => done()))
      rmSync(relinkPath)
      symlinkSync(relinkTarget, relinkPath, 'junction')
      const ok = await writes(relinkFile, () => seen.length, BUDGET)
      await watcher.close()
      console.log(`@@SH relink ${i} ${ok ? 'pass' : 'timeout'} n=${seen.length}@@`)
    }, 20000)
  }

  for (let i = 0; i < ROUNDS; i++) {
    // the reproduction as the report writes it: its own `ignored` predicate,
    // an 80-write budget, and the same replacement after `ready`
    it(`minimal ${i}`, async () => {
      const root = minRoot
      const ignored = (input: string, stats?: any) => {
        const path = resolve(input)
        if (path === root) return false
        if (!stats || stats.isSymbolicLink()) return false
        const rel = path.slice(root.length + 1).split('\\').join('/')
        const isDirectory = stats.isDirectory()
        if (isDirectory) return !rel.startsWith('linked')
        return rel !== 'linked' && !rel.endsWith('.ts')
      }
      writeFileSync(minFile, '')
      rmSync(minPath, { recursive: true, force: true })
      writeFileSync(minPath, '')
      const { watcher, seen } = open(root, { ignored })
      await new Promise<void>((done) => watcher.once('ready', () => done()))
      rmSync(minPath)
      symlinkSync(minTarget, minPath, 'junction')
      const ok = await writes(minFile, () => seen.length, 80)
      const listed = JSON.stringify(watcher.getWatched()).includes('linked')
      await watcher.close()
      console.log(`@@SH minimal ${i} ${ok ? 'pass' : 'timeout'} n=${seen.length} listed=${listed}@@`)
    }, 25000)
  }
})
