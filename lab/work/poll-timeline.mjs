// Poll the snapshot route on a tight timeline and print one line per change.
// Usage: node poll-timeline.mjs [ms] [count]
const MS = Number(process.argv[2] || 250)
const COUNT = Number(process.argv[3] || 120)
const URL = 'http://127.0.0.1:59762/download-progress/state'
const t0 = Date.now()
let last = ''
for (let i = 0; i < COUNT; i += 1) {
  const at = Date.now() - t0
  try {
    const r = await fetch(URL)
    const j = await r.json()
    const rows = j.tasks.map(
      (t) => `${t.id.slice(-6)}|${t.kind}|b=${t.bytes}|tot=${t.total}|spd=${t.speed}|done=${t.done}|unr=${t.unresolved}`,
    )
    const line = `tasks=${j.tasks.length} bg=${j.background.length} :: ${rows.join(' ; ')}`
    if (line !== last) {
      console.log(`${String(at).padStart(6)}ms  ${line}`)
      last = line
    }
  } catch (e) {
    const line = `ERR ${e.message}`
    if (line !== last) {
      console.log(`${String(at).padStart(6)}ms  ${line}`)
      last = line
    }
  }
  await new Promise((r) => setTimeout(r, MS))
}
console.log(`${String(Date.now() - t0).padStart(6)}ms  -- end --`)
