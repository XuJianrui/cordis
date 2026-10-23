import { ModuleJob } from '@cordisjs/plugin-loader'

// a builtin carries no file to watch or reload
export function isBuiltin(url: string) {
  return url.startsWith('node:')
}

/**
 * Collect the transitive static imports of `root`.
 *
 * `node_modules` is traversed: a shared dependency that a plugin imports lives
 * there, and so do the framework modules the host is built from. What stays out
 * is `stop` — the modules that bound this walk, such as the host graph.
 */
export async function collectDependencies(root: ModuleJob, stop?: Set<string>) {
  const dependencies = new Set<string>()
  async function traverse(job: ModuleJob) {
    if (dependencies.has(job.url)) return
    if (isBuiltin(job.url) || stop?.has(job.url)) return
    dependencies.add(job.url)
    // `linked` is a promise on 22 and an array on 24
    const children = await job.linked
    await Promise.all(Array.prototype.map.call(children, traverse))
  }
  await traverse(root)
  return dependencies
}
