import { watch, writeFileSync } from 'node:fs'

const path = process.argv[2]
const trigger = process.argv[3]
let events = 0
const watcher = watch(path, () => {
  events++
  console.log('SHORTPATH_EVENT ' + events)
})

let writes = 0
let timer
const start = setTimeout(() => {
  timer = setInterval(() => {
    writes++
    writeFileSync(trigger, String(writes))
  }, 200)
}, 800)
setTimeout(() => {
  clearTimeout(start)
  clearInterval(timer)
  watcher.close()
  console.log('SHORTPATH_EVENTS ' + events + ' writes=' + writes)
  process.exit(0)
}, 3000)