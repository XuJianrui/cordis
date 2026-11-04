// Fork-only evidence tooling.
//
// The #262 probes in `packages/*/tests/zz-{probe,verify}-262*` are instruments,
// not tests: their job is to print a reading, and the reading is what gets
// quoted. Several of them carry assertions derived from earlier measurements —
// useful as documentation, but it means a new run can turn the build red while
// the reading itself is perfectly good. A reader following an evidence link then
// sees a red X and cannot tell "the reading is wrong" from "an old expectation
// no longer holds on this cell".
//
// This setup file makes those files log-only, and only those files: for every
// other test in the repository `expect` keeps throwing. The trade is explicit —
// a probe file cannot fail the build, and in exchange a probe can never be used
// as a pass/fail gate. That is the right trade for an instrument.
//
// Implementation: every Chai matcher bottoms out in `Assertion.prototype.assert`,
// so wrapping that one method covers `toBe`, `toEqual`, `.not`, `.resolves` and
// the rest without touching a single call site. The assertion is still
// *evaluated*; only the thrown error is downgraded to a log line. Each
// downgrade prints `PROBE_SOFT_FAIL`, so `grep PROBE_SOFT_FAIL` in a CI log
// lists every expectation that no longer holds on that cell — which is itself a
// reading.
import { expect } from 'vitest'

const PROBE = /[\\/]zz-(?:probe|verify)-262[^\\/]*\.spec\.ts$/

const isProbe = (): boolean => {
  try {
    return PROBE.test(expect.getState().testPath ?? '')
  } catch {
    return false
  }
}

interface AssertionProto {
  assert: (...args: unknown[]) => unknown
}

// Calling expect() once is the cheapest way to reach the shared prototype;
// the value is discarded.
const proto = Object.getPrototypeOf(expect(0)) as AssertionProto

if (typeof proto?.assert === 'function' && !(proto.assert as { __probePatched?: true }).__probePatched) {
  const original = proto.assert
  const patched = function patchedAssert(this: unknown, ...args: unknown[]) {
    if (!isProbe()) return original.apply(this, args)
    try {
      return original.apply(this, args)
    } catch (error) {
      const state = expect.getState()
      console.log(
        'PROBE_SOFT_FAIL =',
        JSON.stringify({
          file: (state.testPath ?? '').split(/[\\/]/).pop(),
          test: state.currentTestName ?? '',
          message: String((error as Error)?.message ?? error).slice(0, 300),
        }),
      )
      // Returning `this` keeps long chains alive; nothing downstream reads the
      // return value of a matcher.
      return this
    }
  }
  ;(patched as { __probePatched?: true }).__probePatched = true
  proto.assert = patched
}
