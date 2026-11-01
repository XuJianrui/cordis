/* eslint-disable */
import { execFileSync } from 'node:child_process'
import { it } from 'vitest'

it('deep 262: crash consistency under dm-flakey', () => {
  if (process.platform !== 'linux') return
  const out = execFileSync('bash', ['.probe/crash-linux.sh'], { encoding: 'utf8', timeout: 180000 })
  console.log(out)
}, 200000)
