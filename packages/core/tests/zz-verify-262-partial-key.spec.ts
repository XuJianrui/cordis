// Probe: the realistic shape of the "missing key" question is not the fully
// empty layer `{}` -- it is a layer that names SOME operations and not others.
//
//   outer: { read: ['**'] }
//   inner: { write: ['cache/**'] }      <- names write, omits read
//
// reading A (omission = no constraint): read survives  -> {read:['**'], write:['cache/**']}
// reading B (omission = empty set):     write and read both die -> {read:[], write:[]}
//
// Which one holds is a decision the proposal has to state, not a detail.
// Reading B is not "stricter" -- it annihilates the inner layer's OWN grant,
// which makes the composition rule unusable for a partial config.
import { describe, it } from 'vitest'
import { Context, Service } from '../src/index.ts'

interface Perm { read?: string[], write?: string[] }

function make(merge: (self: any, ...v: Perm[]) => Perm) {
  class Fs extends Service<Perm> {
    constructor(ctx: Context) { super(ctx, 'fs') }
    perms() { return this[Service.resolveIntercept]() }
    [Service.mergeIntercept](...v: Perm[]) { return merge(this, ...v) }
  }
  return Fs
}

// reading A: only keys that appear somewhere are considered
const unionKeys = (_: any, ...values: Perm[]): Perm => {
  const out: Perm = {}
  for (const value of values) {
    for (const key of Object.keys(value) as (keyof Perm)[]) {
      const granted = value[key]!
      if (key in out) out[key] = out[key]!.filter((x) => granted.includes(x))
      else out[key] = [...granted]
    }
  }
  return out
}

// reading B: the key set is the union of all layers, and a key missing from a
// layer contributes an empty set there -> intersection kills it
const intersectAll = (_: any, ...values: Perm[]): Perm => {
  const keys = new Set<string>()
  for (const v of values) for (const k of Object.keys(v)) keys.add(k)
  const out: Perm = {}
  for (const key of keys as Set<keyof Perm>) {
    let acc: string[] | undefined
    for (const v of values) {
      const granted = v[key] ?? []
      acc = acc === undefined ? [...granted] : acc.filter((x) => granted.includes(x))
    }
    out[key] = acc!
  }
  return out
}

describe('partial-key layer: omission semantics', () => {
  for (const [label, merge] of [['A: omission = no constraint', unionKeys], ['B: omission = empty set', intersectAll]] as const) {
    it(`${label}`, async () => {
      const root = new Context()
      await root.plugin(make(merge))
      const outer = root.intercept('fs', { read: ['**'] })
      console.log(`[${label}] OUTER =`, JSON.stringify(outer.fs.perms()))
      const inner = outer.intercept('fs', { write: ['cache/**'] })
      console.log(`[${label}] INNER =`, JSON.stringify(inner.fs.perms()))
    })
  }
})
