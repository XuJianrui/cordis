// The whole matrix in the PR body, measured cell by cell on every platform.
//
// Nothing here is inferred: each cell prints one NDJSON line with what was set up, what was
// written, and what reached a listener. The two arms differ only in `packages/fs-node`, so the
// same file runs unchanged on both.
//
// A cell is **bad** when a `change` reaches a listener for a path that is a directory at that
// instant — that is the false report #295 removes. A cell is **blind** when the control write
// was not delivered, and then its verdict is discarded rather than counted as a pass.
import { Context } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '__m295__')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hardRm = (p: string) => { try { rmSync(p, { recursive: true, force: true }) } catch {} }
const isWin = process.platform === 'win32'

type Shape = 'file' | 'dir' | 'linkDir' | 'linkFile' | 'absent'

const rows: string[] = []

function emit(cell: string, ok: boolean, extra: any) {
  rows.push(JSON.stringify({ cell, ...extra }))
}

// Build one entry at `path` in the requested shape, with a target beside the tree.
// Returns false when this platform cannot build that shape.
function build(path: string, shape: Shape, tag: string): boolean {
  const target = resolve(root, `target-${tag}`)
  switch (shape) {
    case 'file':
      writeFileSync(path, 'v1')
      return true
    case 'dir':
      mkdirSync(path, { recursive: true })
      writeFileSync(resolve(path, 'inner.ts'), 'v1')
      return true
    case 'linkDir':
      mkdirSync(target, { recursive: true })
      writeFileSync(resolve(target, 'inner.ts'), 'v1')
      try { symlinkSync(target, path, isWin ? 'junction' : 'dir') } catch { return false }
      return true
    case 'linkFile':
      writeFileSync(target, 'v1')
      try { symlinkSync(target, path, isWin ? 'file' : 'file') } catch { return false }
      return true
    case 'absent':
      return true
  }
}

// One cell: watch something, let it settle, prove the rig speaks, then apply the change and
// record every `change` that names a path which is a directory at that instant.
async function cell(name: string, opts: {
  shape: 'auto' | 'file' | 'dir'
  filter?: string[]
  start: Shape
  end: Shape
  timing?: 'idle' | 'immediate' | 'reswap'
  writes?: number
  atomic?: boolean
}) {
  hardRm(root)
  mkdirSync(root, { recursive: true })
  const tree = resolve(root, 'tree')
  mkdirSync(tree, { recursive: true })
  const entry = resolve(tree, 'entry.ts')

  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Fs)

  let target = tree
  if (opts.shape === 'file') target = entry
  const built = build(entry, opts.start, 'a')
  if (!built) {
    emit(name, false, { skipped: 'cannot build start shape', start: opts.start })
    await ctx.dispose?.()
    return
  }

  const seen: string[] = []
  // every report is recorded twice: what its stats claim, and what the path is at that instant.
  // The two are compared; a disagreement would mean the predicate reads a stale or foreign
  // `stats`, which is a different defect from the one this PR removes.
  // NOTE: the adapter emits `change` with the path alone (`_emit('change', resolve(path))`), so
  // a listener never receives stats. Comparing "what stats claim" is therefore impossible from
  // outside and is not attempted here; the verdict uses the path's type on disk.
  // One record per report, holding both the path and the type on disk at that instant.
  // Deliberately not two parallel arrays: a reset of one without the other silently shifts
  // every later verdict onto an earlier event, which is a mistake this file has made once.
  const records: { path: string, isDir: boolean }[] = []
  const reset = () => { records.length = 0 }
  const w = ctx.fs.watch(target, opts.filter ? { filter: opts.filter } : {})
  w.on('change', (f: string) => {
    records.push({ path: String(f), isDir: !!statSync(f, { throwIfNoEntry: false })?.isDirectory() })
  })
  await new Promise<void>(r => w.on('ready', () => r()))
  await sleep(350)

  // Control: one write to a file that is already inside this watch's scope. Where that file
  // lives follows from the registration shape, not from convenience:
  //   watch(file)  -> the parent is watched at depth 0, admitting only that name
  //   watch(dir)   -> the directory itself is watched, recursively
  //   absent       -> the parent is watched for the name, but the first write is an `add`,
  //                   so it takes a create, a pause, and then a real modification
  let ctlHeard = false
  let ctlReason = ''
  const inScope = () => (opts.shape === 'file'
    ? entry
    : (opts.start === 'dir' || opts.start === 'linkDir')
      ? resolve(entry, 'inner.ts')
      : entry)

  const exclusions = opts.filter ? opts.filter.filter(f => f.startsWith('!')).map(f => f.slice(1)) : []
  const excluded = exclusions.some(g => g.includes('entry'))
  if (excluded) {
    ctlReason = 'filter excludes the entry, so no control write can be delivered'
  } else if (opts.atomic) {
    // an atomic rename of the same bytes is the stimulus itself; there is no separate control
    ctlHeard = true
    ctlReason = 'control is the atomic save itself'
  } else {
    if (opts.start === 'absent') {
      writeFileSync(inScope(), 'seed')
      await sleep(600)
      reset()
    }
    writeFileSync(inScope(), 'ctl-1')
    await sleep(700)
    ctlHeard = records.length > 0
    if (!ctlHeard) ctlReason = 'write in scope was not delivered'
  }
  reset()

  // the change under test
  rmSync(entry, { recursive: true, force: true })
  if (opts.atomic) {
    // temp file renamed over the target — the path this adapter deliberately watches a
    // directory for
    const tmp = `${entry}.tmp`
    writeFileSync(tmp, 'atomic')
    renameSync(tmp, entry)
  } else if (opts.timing !== 'reswap') {
    build(entry, opts.end, 'b')
  }

  if (opts.timing === 'immediate') {
    build(entry, opts.end, 'b')
    writeFileSync(resolve(entry, 'now.ts'), 'x')
  } else if (opts.timing === 'reswap') {
    build(entry, 'file', 'c')
    rmSync(entry, { force: true })
    build(entry, opts.end, 'd')
  }

  if (opts.writes) {
    for (let i = 0; i < opts.writes; i++) {
      try { writeFileSync(entry, `w${i}`) } catch { /* directory now */ }
      await sleep(60)
    }
  }

  await sleep(opts.timing === 'immediate' ? 1400 : 900)

  // verdict: a false report is one whose path was a directory *at the moment it was
  // reported*. `pairs` holds that, recorded inside the listener; a `stat` taken here,
  // after the fact, answers a different question — the path may have changed back.
  let falseReports = 0
  const named: string[] = []
  for (const r of records) {
    if (r.isDir) { falseReports++; named.push(r.path.slice(root.length + 1)) }
  }
  const reported = records.length
  emit(name, true, {
    start: opts.start, end: opts.end, shape: opts.shape, filter: opts.filter ?? null,
    timing: opts.timing ?? 'idle', writes: opts.writes ?? 0, atomic: !!opts.atomic,
    ctl: ctlHeard ? 1 : 0, ctlReason, reported, falseReports, named: named.slice(0, 3),
    comparisons: records.length,
  })

  await w.dispose()
  await ctx.dispose?.()
  await sleep(100)
}

describe('the matrix', () => {
  afterAll(() => { hardRm(root) })

  it('runs every cell and prints one line each', async () => {
    const shapes: Shape[] = ['file', 'dir', 'linkDir', 'linkFile', 'absent']

    // 1. the entry's start and end shape, 5 × 5 = 25 cells
    for (const start of shapes) {
      for (const end of shapes) {
        await cell(`shape:${start}->${end}`, { shape: 'auto', start, end })
      }
    }

    // 2. entry point: a watch on the file itself, 2 cells
    for (const start of ['file', 'linkFile'] as Shape[]) {
      for (const end of ['dir'] as Shape[]) {
        await cell(`single:${start}->${end}`, { shape: 'file', start, end })
      }
    }

    // 3. filter, 4 settings × 3 transitions = 11 usable cells
    const filters = [undefined, ['*.ts', '!**/node_modules'], ['entry.ts'], ['*.ts', '!entry.ts']]
    const pairs: [Shape, Shape][] = [['file', 'dir'], ['dir', 'file'], ['file', 'file']]
    let n = 0
    for (const f of filters) {
      for (const [s, e] of pairs) {
        if (n++ >= 11) break
        await cell(`filter:${f ? f.join('|') : 'none'}:${s}->${e}`, { shape: 'auto', start: s, end: e, filter: f as string[] | undefined })
      }
    }

    // 4. timing after the swap, 3 cells
    for (const t of ['idle', 'immediate', 'reswap'] as const) {
      await cell(`timing:${t}`, { shape: 'auto', start: 'file', end: 'dir', timing: t })
    }

    // 5. the same path written 40× with two watchers on it, 1 cell
    {
      hardRm(root); mkdirSync(root, { recursive: true })
      const tree = resolve(root, 'tree'); mkdirSync(tree, { recursive: true })
      const entry = resolve(tree, 'entry.ts')
      writeFileSync(entry, 'v1')
      const ctx = new Context(); ctx.baseUrl = import.meta.url
      await ctx.plugin(Fs)
      const a: string[] = []; const b: string[] = []
      const w1 = ctx.fs.watch(tree, {}); w1.on('change', (f: string) => a.push(String(f)))
      const w2 = ctx.fs.watch(tree, {}); w2.on('change', (f: string) => b.push(String(f)))
      await Promise.all([new Promise<void>(r => w1.on('ready', () => r())), new Promise<void>(r => w2.on('ready', () => r()))])
      await sleep(400)
      writeFileSync(entry, 'ctl'); await sleep(700)
      const ctl = a.length > 0 && b.length > 0
      a.length = 0; b.length = 0
      for (let i = 0; i < 40; i++) { writeFileSync(entry, `v${i}`); await sleep(25) }
      await sleep(900)
      const falseA = a.filter(f => statSync(f, { throwIfNoEntry: false })?.isDirectory()).length
      const falseB = b.filter(f => statSync(f, { throwIfNoEntry: false })?.isDirectory()).length
      emit('forty:two-watchers', true, { ctl: ctl ? 1 : 0, reported: a.length + b.length, falseReports: falseA + falseB, named: [] })
      await w1.dispose(); await w2.dispose(); await ctx.dispose?.()
      await sleep(150)
    }

    // 6. the save that must keep working: an atomic save, then the entry becomes a directory,
    // then the editor saves again over that path. Counted, not asserted.
    {
      hardRm(root); mkdirSync(root, { recursive: true })
      const tree = resolve(root, 'tree'); mkdirSync(tree, { recursive: true })
      const entry = resolve(tree, 'entry.ts')
      writeFileSync(entry, 'v1')
      const ctx = new Context(); ctx.baseUrl = import.meta.url
      await ctx.plugin(Fs)
      const seen: string[] = []
      const kinds: boolean[] = []
      const w = ctx.fs.watch(entry, {})
      w.on('change', (f: string) => {
        seen.push(String(f))
        kinds.push(!!statSync(f, { throwIfNoEntry: false })?.isDirectory())
      })
      await new Promise<void>(r => w.on('ready', () => r()))
      await sleep(350)

      const atomicSave = async () => {
        const tmp = `${entry}.tmp`
        writeFileSync(tmp, 'atomic')
        renameSync(tmp, entry)
      }

      // control + first row: an atomic save over an existing file
      seen.length = 0
      kinds.length = 0
      await atomicSave()
      await sleep(900)
      const saveCount = seen.length

      // second row: the entry becomes a directory
      seen.length = 0
      kinds.length = 0
      rmSync(entry, { force: true })
      mkdirSync(entry, { recursive: true })
      writeFileSync(resolve(entry, 'inner.ts'), 'x')
      await sleep(1200)
      const dirReports = kinds.filter(Boolean).length
      const dirTotal = seen.length

      // third row: the editor saves again over that path
      seen.length = 0
      kinds.length = 0
      rmSync(entry, { recursive: true, force: true })
      await atomicSave()
      await sleep(1200)
      const backCount = seen.length

      emit('save:sequence', true, {
        ctl: saveCount > 0 ? 1 : 0, reported: saveCount,
        atomicSave: saveCount, dirReports, dirTotal, backCount,
        falseReports: dirReports, named: [],
      })
      await w.dispose(); await ctx.dispose?.()
      await sleep(150)
    }

    for (const line of rows) console.log('@@M295 ' + line)
    console.log(`@@M295DONE cells=${rows.length} bad=${rows.filter(r => (JSON.parse(r).falseReports ?? 0) > 0).length} blind=${rows.filter(r => JSON.parse(r).ctl === 0).length}`)
  }, 600000)
})
