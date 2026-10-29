import type { ModuleLoader } from '@cordisjs/loader-utils'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'

const require = createRequire(import.meta.url)

function toPath(url: string) {
  try {
    const path = fileURLToPath(url)
    if (require.cache[path]) return path
    try {
      const real = fs.realpathSync(path)
      if (require.cache[real]) return real
    } catch {}
    return path
  } catch {
    return undefined
  }
}

/** An edge cut from a parent's `children`, with the position it had there. */
interface CutEdge {
  parent: string
  child: string
  index: number
}

/** Every module in the CJS cache, as `file:` URLs. */
export function cjsUrls(): string[] {
  return Object.keys(require.cache).map(path => pathToFileURL(path).href)
}

/** Whether the module at `url` is loaded in the CJS cache. */
export function cjsHas(url: string) {
  const path = toPath(url)
  return !!path && !!require.cache[path]
}

/** The dependencies of the CJS module at `url`, as `file:` URLs. */
export function cjsChildren(url: string): string[] {
  const path = toPath(url)
  const children = (path && require.cache[path]?.children) || []
  return children.map(child => pathToFileURL(child.filename).href)
}

/**
 * Evicts modules from both module caches for the duration of a transaction,
 * and puts back the ones whose unit aborted.
 *
 * The two systems record an edge differently. The ESM loader keeps a module's
 * static imports in `linked`, so dropping its `loadCache` entry cuts them all
 * at once. A CJS module is instead listed in its parents' `children` arrays,
 * and deleting `require.cache[path]` leaves those entries behind: the evicted
 * instance stays reachable through the reverse dependency graph, which is what
 * `Hmr#_edges` and `Hmr#_analyze` read. They are cut here in one reverse scan.
 *
 * Only the edges that were actually cut are recorded, each with its position,
 * so that `restore` can put them back one by one. Replacing a parent's whole
 * array from a snapshot would also drop the children a parent gained while the
 * transaction was importing.
 */
export class ModuleCache {
  private esmBackup: Record<string, unknown> = Object.create(null)
  private cjsBackup: Record<string, NodeJS.Module> = Object.create(null)
  private cuts: CutEdge[] = []

  constructor(private internal: ModuleLoader) {}

  evict(urls: Iterable<string>) {
    const paths = new Set<string>()
    for (const url of urls) {
      // `loadCache` is a `LoadCache`: its entries are `{ [type]: ModuleJob }`,
      // one job per value of the `type` import attribute. Its own `delete(url)`
      // only sets the `javascript` slot to undefined and keeps the entry,
      // while `Map.prototype.delete` removes the whole entry. `LoadCache`
      // extends Node's internal `SafeMap`, which carries the Map internal
      // slots, so Map.prototype methods apply to it although
      // `loadCache instanceof Map` is false.
      if (!(url in this.esmBackup)) {
        this.esmBackup[url] = Map.prototype.get.call(this.internal.loadCache, url)
      }
      Map.prototype.delete.call(this.internal.loadCache, url)

      const path = toPath(url)
      if (!path) continue
      if (require.cache[path]) {
        this.cjsBackup[path] ??= require.cache[path]
        paths.add(path)
      }
    }
    if (!paths.size) return

    // one reverse scan cuts every edge of the batch at once
    for (const key of Object.keys(require.cache)) {
      if (paths.has(key)) continue
      const parent = require.cache[key]
      if (!parent) continue
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const child = parent.children[i]
        if (!child || !paths.has(child.filename)) continue
        this.cuts.push({ parent: key, child: child.filename, index: i })
        parent.children.splice(i, 1)
      }
    }
    for (const path of paths) {
      delete require.cache[path]
    }
  }

  /**
   * Put back the recorded state of `urls`, which are the evicted modules of the
   * units that aborted. A parent gets back exactly the edges it had for those
   * modules, at the position they were in, and keeps every other entry it holds
   * by then — the ones of the modules that stay evicted are already gone.
   *
   * Calls accumulate: the modules restored by an earlier call stay restored.
   */
  restore(urls: Iterable<string>) {
    const paths = new Set<string>()
    for (const url of urls) {
      // stage 1 may have imported a new version of the module
      Map.prototype.delete.call(this.internal.loadCache, url)
      const job = this.esmBackup[url]
      if (job) Map.prototype.set.call(this.internal.loadCache, url, job)

      const path = toPath(url)
      if (!path) continue
      paths.add(path)
      if (this.cjsBackup[path]) require.cache[path] = this.cjsBackup[path]
    }
    if (!paths.size) return

    // ascending, so that several edges of one parent land where they were
    const back = this.cuts
      .filter(cut => paths.has(cut.child))
      .sort((a, b) => a.index - b.index)
    for (const cut of back) {
      const parent = require.cache[cut.parent]
      if (!parent) continue
      const child = require.cache[cut.child]
      if (!child || parent.children.includes(child)) continue
      parent.children.splice(Math.min(cut.index, parent.children.length), 0, child)
    }
    this.cuts = this.cuts.filter(cut => !paths.has(cut.child))
  }
}
