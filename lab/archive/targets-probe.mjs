/**
 * What target does each shape resolve to? Byte-watching only works when this is
 * a real file that actually grows — a directory or a response body never will.
 */
import { classify, extractTargets, aria2InputSpec } from '../detect.js'

const cwd = 'D:\\AIworks'
const cases = [
  ['T3  curl -O', 'curl.exe -O http://h/a/win.iso'],
  ['T11 git clone', 'git clone --depth 1 https://github.com/o/Hello-World.git D:\\lab\\t11'],
  ['T11b git clone no dest', 'git clone https://github.com/o/r.git'],
  ['T16 upload -T -o', 'curl.exe -T D:\\lab\\big.bin http://h/upload -o D:\\lab\\resp.txt'],
  ['T16b upload -T only', 'curl.exe -T D:\\lab\\big.bin http://h/upload'],
  ['T20 curl -o var', '$d="D:\\lab\\v.bin"; curl.exe -o $d http://h/f'],
  ['T10 aria2c -i', 'aria2c -i D:\\lab\\aria3\\list.txt'],
  ['T9  aria2c -o', 'aria2c -o t9.bin http://h/f'],
]

for (const [name, command] of cases) {
  const plan = classify({ name: 'pwsh', arguments: { command } })
  const targets = extractTargets(command, cwd)
  console.log(`${name.padEnd(24)} kind=${plan?.kind ?? 'null'} targets=${JSON.stringify(targets)}`)
}

console.log('\naria2InputSpec:', JSON.stringify(aria2InputSpec('aria2c -i D:\\lab\\aria3\\list.txt')))
console.log('aria2InputSpec no -i:', JSON.stringify(aria2InputSpec('aria2c -o x http://h/f')))
