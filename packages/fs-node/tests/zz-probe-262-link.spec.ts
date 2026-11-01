/* eslint-disable */
// Probe 262: symlink follow semantics, run through Node on every runner.
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

it('probe 262: symlink follow semantics', () => {
  const output = execFileSync(process.execPath, [resolve(root, '.probe/symlink-follow.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  console.log(output)
}, 120_000)
