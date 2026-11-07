// The user scenario: `git checkout` across a branch where a path is a file on one and a
// directory of the same name on the other. That is how this reaches a real project — not by
// anyone running `rm` + `mkdir` by hand.
//
// The repository is built inside the fixture directory and removed afterwards, so the test
// carries its own history instead of depending on one.
import { Context } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '__git295__')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hardRm = (p: string) => { try { rmSync(p, { recursive: true, force: true }) } catch {} }
const sh = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString()

afterAll(() => hardRm(repo))

it('a branch switch that turns a file into a directory reports no change for it', async () => {
  hardRm(repo)
  mkdirSync(repo, { recursive: true })
  sh('init', '-q')
  sh('config', 'user.email', 'probe@example.com')
  sh('config', 'user.name', 'probe')
  sh('config', 'core.hooksPath', resolve(here, '__no_hooks__'))
  writeFileSync(resolve(repo, 'thing'), 'file-version')
  sh('add', '.')
  sh('commit', '-qm', 'file')
  sh('checkout', '-qb', 'dir-branch')
  sh('rm', '-q', 'thing')
  mkdirSync(resolve(repo, 'thing'), { recursive: true })
  writeFileSync(resolve(repo, 'thing/inner.ts'), 'inner')
  sh('add', '.')
  sh('commit', '-qm', 'dir')
  sh('checkout', '-q', '-f', 'master')
  sh('clean', '-fdq')

  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Fs)
  const seen: string[] = []
  const w = ctx.fs.watch(repo, {})
  w.on('change', (f: string) => seen.push(String(f)))
  await new Promise<void>(r => w.on('ready', () => r()))

  // Watching a repository root hits `.git` internals, so the control is retried: without a
  // control the silence below would mean nothing.
  let ctl = false
  for (let i = 0; i < 12 && !ctl; i++) {
    seen.length = 0
    writeFileSync(resolve(repo, 'witness.txt'), `w${i}`)
    await sleep(400)
    ctl = seen.some(f => f.endsWith('witness.txt'))
  }

  seen.length = 0
  sh('checkout', '-q', '-f', 'dir-branch')
  await sleep(1600)
  const thing = resolve(repo, 'thing')
  const isDirNow = !!statSync(thing, { throwIfNoEntry: false })?.isDirectory()
  const falseReports = seen.filter(f => !!statSync(f, { throwIfNoEntry: false })?.isDirectory()).length

  let userErr = ''
  try { writeFileSync(thing, 'after') } catch (e: any) { userErr = String(e?.code ?? e) }

  console.log('@@GIT295 ' + JSON.stringify({ cell: 'gitCheckout', ctl: ctl ? 1 : 0, isDir: isDirNow ? 1 : 0, falseReports, userErr: userErr || 'none' }))
  expect(ctl).to.equal(true)
  expect(isDirNow).to.equal(true)
  expect(falseReports).to.equal(0)

  await w.dispose()
  sh('checkout', '-q', '-f', 'master')
  sh('clean', '-fdq')
}, 60000)
