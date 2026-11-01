import { watch, writeFileSync } from 'node:fs'

const path = process.argv[2]
const trigger = process.argv[3]
const watcher = watch(path, () => {})
setTimeout(() => {
  writeFileSync(trigger, 'x')
}, 50)
setTimeout(() => {
  watcher.close()
  process.exit(0)
}, 500)