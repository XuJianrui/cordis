/* eslint-disable */
// Probe 262: watching a file itself vs watching its parent across an atomic rename.
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

it('probe 262: rename survival mechanism', () => {
  const output = execFileSync(process.execPath, [resolve(root, '.probe/rename-mechanism.mjs')], {
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, PROBE262_RUNS: process.env.PROBE262_RUNS || '5' },
  })
  console.log(output)
}, 300_000)
