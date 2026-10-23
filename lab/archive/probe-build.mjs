/**
 * Two questions, one probe:
 *
 * 1. Does the *workspace* script.js strip the comment for the exact body that is
 *    live on disk right now? (The running app still showed the comment as the
 *    card title, which suggests it loaded an older build.)
 * 2. What does a `param(...)` script with no default look like to scriptTargets?
 */
import { readFileSync } from 'node:fs'
import { scriptPlan, scriptTargets } from '../script.js'

const literal = 'D:\\AIworks\\dsh-download-progress\\lab\\tmp\\t23-literal.ps1'
const param = 'D:\\AIworks\\dsh-download-progress\\lab\\tmp\\t21-comment.ps1'

for (const [name, path] of [
  ['t23 literal path + comment', literal],
  ['t21 param no default', param],
]) {
  const body = readFileSync(path, 'utf8')
  console.log(`=== ${name}`)
  console.log('  scriptTargets ->', JSON.stringify(scriptTargets(body, {})))
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${path}"`
  console.log('  scriptPlan    ->', JSON.stringify(scriptPlan(command, 'D:\\AIworks')))
}
