/* eslint-disable */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function run(name: string, env: Record<string, string> = {}) {
  return execFileSync(process.execPath, [resolve(root, '.probe', name)], {
    encoding: 'utf8',
    timeout: 600_000,
    env: { ...process.env, ...env },
  })
}

it('probe 262: watch grid', () => {
  const runs = process.platform === 'darwin' ? '5' : '1'
  const output = run('watch-grid.mjs', { PROBE262_RUNS: runs })
  console.log(output)
  expect(output).toContain('GRID_DONE')
}, 600_000)

it('probe 262: symlink creation and removal', () => {
  const output = run('symlink.mjs')
  console.log(output)
  expect(output).toContain('SYMLINK_SUMMARY')
  if (process.platform !== 'win32') {
    expect(output).toContain('"created":10')
    expect(output).toContain('"lstatSymlink":10')
    expect(output).toContain('"removed":10')
    expect(output).toContain('"targetsIntact":10')
  }
}, 120_000)

it('probe 262: 8.3 short path', () => {
  if (process.platform !== 'win32') return
  const output = run('shortpath.mjs')
  console.log(output)
  expect(output).toContain('SHORTPATH_ENV')
}, 120_000)