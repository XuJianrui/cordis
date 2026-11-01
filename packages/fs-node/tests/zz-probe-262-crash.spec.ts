/* eslint-disable */
// D4: crash consistency under dropped writes. Linux only -- dm-flakey is a
// device-mapper target and the CI runner needs sudo. The probe carries its own
// positive controls: PROBE262_DM_AT_KILL proves the flakey target is live at
// kill time, PROBE262_CRASH_CONTROL proves the device still works afterwards,
// so a passing 'old'/'new' reading cannot be the trivial result of a dead
// device. The script also exits non-zero on a torn target, and this test
// re-checks the same fields so a script that prints nothing cannot pass.
import { execFileSync } from 'node:child_process'
import { it } from 'vitest'

it('deep 262: crash consistency under dm-flakey drop_writes', () => {
  if (process.platform !== 'linux') return
  let out = ''
  try {
    out = execFileSync('bash', ['.probe/crash-linux.sh'], {
      encoding: 'utf8',
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e: any) {
    console.log('PROBE262_CRASH_STDOUT\n' + String(e.stdout || '').trim())
    console.log('PROBE262_CRASH_STDERR\n' + String(e.stderr || '').trim())
    throw e
  }
  console.log(out.trim())

  const m = out.match(/PROBE262_CRASH (\{.*\})/)
  if (!m) throw new Error('PROBE262_CRASH line missing')
  const r = JSON.parse(m[1])
  if (!r.ok) throw new Error('torn or missing target: ' + r.content)
  if (!/PROBE262_CRASH_CONTROL \{"content":"control"\}/.test(out)) {
    throw new Error('control write missing -- device may be dead')
  }
  if (!/PROBE262_DM_AT_KILL .*flakey/.test(out)) {
    throw new Error('flakey target was not live at kill time')
  }
}, 200000)
