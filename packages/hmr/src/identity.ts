import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Identity {
  // the realpath, the key of the store, and the `file:` URL the module was
  // loaded from, which is what the rest of hmr speaks
  path: string
  url: string
  // read with `{ bigint: true }`: as numbers, `ino` and `mtimeNs` lose
  // precision — NTFS indices pass 2^53, where two files a step apart
  // collapse into one — and `mtimeNs` is the finest timestamp the stat offers
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  // `Date.now()`, read before the stat: file timestamps come from the same
  // realtime clock, while `performance.now()` is monotonic and not comparable
  observedAt: number
  // the content hash, recorded when the timestamps alone cannot settle the
  // question; reading content costs I/O, so it is skipped otherwise
  hash?: string
}

// Compares module files against their recorded identity: `changed` answers
// whether a file can be proven unchanged, and what cannot be proven counts
// as changed.
export class IdentityStore {
  // realpath -> Identity. Records are kept for the process lifetime: HMR has
  // no event that proves a module left every closure, so `forget` is explicit.
  // A long-running process can read `hmr.reloads` to decide when a restart is
  // cheaper than the retained records.
  private records = new Map<string, Identity>()

  // `window`: how long after a write an observation of it stays suspicious,
  // in milliseconds. The write clock ticks about once per millisecond, so an
  // observation taken `window` or more after the last write can trust the
  // timestamps; a younger one cannot, and the content decides instead. The
  // default also covers filesystems that stamp whole seconds.
  constructor(public window = 1000) {}

  observe(url: string): Identity | undefined {
    const path = toPath(url)
    if (!path) return undefined
    // the clock is read before the stat, so the window covers the stat itself
    const observedAt = Date.now()
    const st = stat(path)
    if (!st) return undefined
    const record: Identity = {
      path,
      url,
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeNs: st.mtimeNs,
      observedAt,
    }
    if (!this.trustworthy(record)) record.hash = hashPath(path)
    this.records.set(path, record)
    return record
  }

  observeAll(urls: Iterable<string>) {
    for (const url of urls) this.observe(url)
  }

  changed(url: string): boolean {
    const path = toPath(url)
    // gone, or resolving somewhere no record was made for
    if (!path) return true
    const rec = this.records.get(path)
    // never observed: the content cannot be proven unchanged
    if (!rec) return true
    const st = stat(rec.path)
    // deleted since the observation
    if (!st) return true
    // a difference proves the change; the reverse does not hold, because a
    // write that lands in the same tick as the recorded one leaves all four
    // fields untouched
    if (st.dev !== rec.dev || st.ino !== rec.ino || st.size !== rec.size) return true
    if (st.mtimeNs !== rec.mtimeNs) return true
    if (this.trustworthy(rec)) return false
    return hashPath(rec.path) !== rec.hash
  }

  has(url: string): boolean {
    const path = toPath(url)
    return !!path && this.records.has(path)
  }

  // Every recorded or loaded module under `root` whose content cannot be
  // proven unchanged. The directory tree is not walked: only files that are
  // already recorded or loaded can affect the runtime, which is what keeps a
  // `node_modules` root with tens of thousands of files cheap.
  expand(root: string, loaded: Iterable<string>): string[] {
    const rootPath = toPath(root)
    if (!rootPath) return []
    let raw: string | undefined
    try {
      raw = fileURLToPath(root)
    } catch {}
    // An isolated-layout install retargets a package symlink; the loaded
    // modules still live at the old real path. Match them by package name and
    // include all of them, since their files are unchanged but the package
    // they belong to is not.
    const retarget = raw && isLink(raw) ? packageName(rootPath) : undefined
    const candidates = new Set<string>()
    const retargeted = new Set<string>()
    for (const rec of this.records.values()) {
      if (under(rec.path, rootPath)) candidates.add(rec.url)
      else if (retarget && belongsTo(rec.path, retarget)) retargeted.add(rec.url)
    }
    for (const url of loaded) {
      // The old real path may already be gone: the package manager can delete
      // the versioned directory before `reconcile` runs. `toPath` needs the
      // file to exist, but the URL still contains the old path, and that path
      // carries the package name under `node_modules`.
      const path = toPath(url) ?? rawPath(url)
      // loaded after the last observation: no record to compare against yet
      if (!path || this.records.has(path)) continue
      if (under(path, rootPath)) candidates.add(url)
      else if (retarget && belongsTo(path, retarget)) retargeted.add(url)
    }
    return [...new Set([
      ...[...candidates].filter(url => this.changed(url)),
      ...retargeted,
    ])]
  }

  // Drop the record for `path`, e.g. once its module left the graph.
  forget(path: string) {
    this.records.delete(path)
  }

  private trustworthy(rec: Identity) {
    return rec.mtimeNs < BigInt(rec.observedAt) * 1_000_000n - BigInt(this.window) * 1_000_000n
  }
}

function toPath(url: string) {
  try {
    return realpathSync(fileURLToPath(url))
  } catch {
    return undefined
  }
}

function rawPath(url: string) {
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

// Whether `path` belongs to the retargeted package `name`. The manifest wins
// when it is still on disk; after the old versioned directory is deleted, the
// path itself still names the package under `node_modules`.
function belongsTo(path: string, name: string) {
  if (packageName(path) === name) return true
  const marker = `${sep}node_modules${sep}`
  const index = path.lastIndexOf(marker)
  if (index < 0) return false
  const rest = path.slice(index + marker.length)
  const expected = name.split('/').join(sep)
  return rest === expected || rest.startsWith(expected + sep)
}

function stat(path: string) {
  try {
    return statSync(path, { bigint: true })
  } catch {
    return undefined
  }
}

function hashPath(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function under(path: string, root: string) {
  return path === root || path.startsWith(root + sep)
}

// Package names are cached by directory; `null` means no manifest was found.
const names = new Map<string, string | null>()

function packageName(path: string): string | undefined {
  let dir = path
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir)
  } catch {
    return undefined
  }
  const chain: string[] = []
  while (true) {
    const cached = names.get(dir)
    if (cached !== undefined) {
      for (const item of chain) names.set(item, cached)
      return cached ?? undefined
    }
    chain.push(dir)
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const name = typeof manifest.name === 'string' ? manifest.name : null
      for (const item of chain) names.set(item, name)
      return name ?? undefined
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) {
      for (const item of chain) names.set(item, null)
      return undefined
    }
    dir = parent
  }
}

function isLink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
