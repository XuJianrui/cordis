// The cells the matrix does not have. 数独：把还没填的格子填上。
//
//   1. depth > 1 — an entry two levels below the watched directory becomes a directory.
//      The matrix only has depth 1.
//   2. `watch(URL)` — the signature accepts `string | URL`; the matrix only passes strings.
//   3. `filter` as a predicate function — the matrix only passes arrays.
//   4. a non-file, non-directory entry — a unix socket. `!isDirectory()` admits it, so the
//      choice of predicate matters: `stats.isFile()` would have dropped it.
//   5. `dispose()` mid-swap — does the watch stop cleanly when the entry is a directory?
import { Context } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, it } from 'vitest'
import { createServer } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '__s295__')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hardRm = (p: string) => { try { rmSync(p, { recursive: true, force: true }) } catch {} }
const isDir = (f: string) => !!statSync(f, { throwIfNoEntry: false })?.isDirectory()

async function rig(target: any, options: any = {}) {
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Fs)
  const w = ctx.fs.watch(target, options)
  // One record per report: the path and the type a listener would see at that instant.
  // Deliberately not two parallel arrays — resetting one without the other silently shifts
  // every later verdict onto an earlier event.
  const recs: { path: string, kind: string }[] = []
  w.on('change', (f: string) => {
    const st = statSync(f, { throwIfNoEntry: false })
    recs.push({ path: String(f), kind: st?.isDirectory() ? 'dir' : st ? 'file' : 'gone' })
  })
  const seen = { get length() { return recs.length }, reset() { recs.length = 0 } }
  await new Promise<void>(r => w.on('ready', () => r()))
  await sleep(350)
  return { ctx, w, seen, recs }
}

afterAll(() => hardRm(root))

it('depth 2: an entry two levels down becomes a directory', async () => {
  hardRm(root); mkdirSync(resolve(root, 'a/b'), { recursive: true })
  const entry = resolve(root, 'a/b/deep.ts')
  writeFileSync(entry, 'v1')
  const { w, seen, recs } = await rig(root)

  // control: the rig speaks for this path
  writeFileSync(entry, 'ctl')
  await sleep(700)
  const ctl = seen.length > 0

  seen.reset()
  rmSync(entry, { force: true })
  mkdirSync(entry, { recursive: true })
  writeFileSync(resolve(entry, 'inner.ts'), 'x')
  await sleep(1200)
  console.log('@@S295 ' + JSON.stringify({ cell: 'depth2', ctl: ctl ? 1 : 0, reported: seen.length, falseReports: recs.filter(r => r.kind === 'dir').length }))
  await w.dispose()
})

it('watch(URL) behaves the same as a string', async () => {
  hardRm(root); mkdirSync(resolve(root, 'u'), { recursive: true })
  const entry = resolve(root, 'u/entry.ts')
  writeFileSync(entry, 'v1')
  const { w, seen, recs } = await rig(pathToFileURL(resolve(root, 'u')))

  writeFileSync(entry, 'ctl')
  await sleep(700)
  const ctl = seen.length > 0

  seen.reset()
  rmSync(entry, { force: true })
  mkdirSync(entry, { recursive: true })
  await sleep(1200)
  console.log('@@S295 ' + JSON.stringify({ cell: 'url', ctl: ctl ? 1 : 0, reported: seen.length, falseReports: recs.filter(r => r.kind === 'dir').length }))
  await w.dispose()
})

it('filter as a predicate function', async () => {
  hardRm(root); mkdirSync(resolve(root, 'f'), { recursive: true })
  const entry = resolve(root, 'f/entry.ts')
  writeFileSync(entry, 'v1')
  const { w, seen, recs } = await rig(resolve(root, 'f'), { filter: (p: string) => p.endsWith('.ts') })

  writeFileSync(entry, 'ctl')
  await sleep(700)
  const ctl = seen.length > 0

  seen.reset()
  rmSync(entry, { force: true })
  mkdirSync(entry, { recursive: true })
  await sleep(1200)
  console.log('@@S295 ' + JSON.stringify({ cell: 'filterFn', ctl: ctl ? 1 : 0, reported: seen.length, falseReports: recs.filter(r => r.kind === 'dir').length }))
  await w.dispose()
})

it('a unix socket is neither file nor directory', async () => {
  if (process.platform === 'win32') {
    console.log('@@S295 socket skipped=win32')
    return
  }
  hardRm(root); mkdirSync(resolve(root, 's'), { recursive: true })
  const sock = resolve(root, 's/app.sock')
  const sibling = resolve(root, 's/sibling.ts')
  // an existing file, so the control is a modification and not an `add`
  writeFileSync(sibling, 'v1')

  const server = createServer()
  await new Promise<void>((r, j) => server.listen(sock, () => r()).once('error', j))
  const { w, seen, recs } = await rig(resolve(root, 's'))

  seen.reset()
  writeFileSync(sibling, 'v2')
  await sleep(700)
  const ctl = recs.some(r => r.path === sibling)

  const st = statSync(sock)
  const shape = `isFile=${st.isFile()} isDir=${st.isDirectory()} isSocket=${st.isSocket()}`

  seen.reset()
  rmSync(sock, { force: true })
  await new Promise<void>((r) => server.close(() => r()))
  await sleep(900)
  const onSock = recs.filter(r => r.path === sock).length

  console.log('@@S295 ' + JSON.stringify({ cell: 'socket', ctl: ctl ? 1 : 0, shape, changeOnSock: onSock }))
  await w.dispose()
})

it('dispose during the swap stops cleanly', async () => {
  hardRm(root); mkdirSync(resolve(root, 'd'), { recursive: true })
  const entry = resolve(root, 'd/entry.ts')
  writeFileSync(entry, 'v1')
  const { w, seen, recs } = await rig(resolve(root, 'd'))

  rmSync(entry, { force: true })
  mkdirSync(entry, { recursive: true })
  await w.dispose()
  const before = recs.length
  try { writeFileSync(resolve(entry, 'after.ts'), 'x') } catch { /* ignore */ }
  await sleep(900)
  console.log('@@S295 ' + JSON.stringify({ cell: 'dispose', ctl: null, reportedBefore: before, reportedAfter: recs.length - before }))
})

it('how many reports do twelve writes inside the new directory produce', async () => {
  hardRm(root); mkdirSync(resolve(root, 'w'), { recursive: true })
  const entry = resolve(root, 'w/entry.ts')
  writeFileSync(entry, 'v1')
  const { w, seen, recs } = await rig(resolve(root, 'w'))

  writeFileSync(entry, 'ctl')
  await sleep(700)
  const ctl = seen.length > 0

  seen.reset()
  rmSync(entry, { force: true })
  mkdirSync(entry, { recursive: true })
  for (let i = 0; i < 12; i++) {
    writeFileSync(resolve(entry, 'inner.txt'), `v${i}`)
    await sleep(100)
  }
  await sleep(900)
  const naming = recs.filter(r => r.path === entry).length
  console.log('@@S295 ' + JSON.stringify({ cell: 'twelve', ctl: ctl ? 1 : 0, namingEntry: naming, total: recs.length }))
  await w.dispose()
})
