/**
 * Does a *comment* that mentions -OutFile create a phantom card?
 *
 * The regression matrix turned this up in practice: a script whose header comment
 * says "…用 Invoke-WebRequest -OutFile 落盘" produced the target
 * `落盘（字节由` and the card was titled with that garbage. If a comment alone can
 * produce a target, a script that never writes a file can also produce a card.
 */
import { scriptTargets, scriptPlan } from '../script.js'

const cases = [
  [
    'comment mentions -OutFile, script only prints',
    [
      '# 这个脚本只用 Invoke-WebRequest -OutFile 说明一下，不真的写文件',
      'Write-Host "hello"',
    ].join('\n'),
  ],
  [
    'comment mentions -OutFile, real -OutFile present',
    [
      '# 用 -OutFile 落盘',
      "$p = 'D:\\real\\out.bin'",
      'Invoke-WebRequest -Uri http://h/f -OutFile $p',
    ].join('\n'),
  ],
  [
    'block comment mentions -o',
    [
      '<#',
      '  curl -o D:\\commented.bin http://h/f   # 仅示例',
      '#>',
      'Write-Host done',
    ].join('\n'),
  ],
  [
    'no comment at all',
    ["$p = 'D:\\real\\out2.bin'", 'Invoke-WebRequest -Uri http://h/f -OutFile $p'].join('\n'),
  ],
]

for (const [name, body] of cases) {
  console.log(`${name}\n  -> ${JSON.stringify(scriptTargets(body, {}))}`)
}
