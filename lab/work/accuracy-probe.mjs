import { classify, extractTargets } from '../../detect.js'

const CWD = 'D:\\work'
const cases = [
  ['capture-assign iwr', '$r = Invoke-WebRequest -Uri https://x/a.zip -OutFile D:\\a.zip'],
  ['capture-assign curl', '$r = curl.exe -o D:\\a.bin https://x/y'],
  ['capture iwr compact', '$r=iwr https://x/a.zip -OutFile D:\\a.zip'],
  ['bash env prefix', 'FOO=1 curl -o a.bin https://x/y'],
  ['colon OutFile', 'Invoke-WebRequest -Uri https://x/a.zip -OutFile:D:\\a.zip'],
  ['colon iwr', 'iwr https://x/a.zip -OutFile:out.zip'],
  ['curl output equals', 'curl --output=D:\\a.bin https://x/y'],
  ['curl odoc equals', 'curl --output-document=a.bin https://x/y'],
  ['plain iwr', 'Invoke-WebRequest -Uri https://x/a.zip -OutFile D:\\a.zip'],
  ['plain curl', 'curl -o D:\\a.bin https://x/y'],
  ['bits named', 'Start-BitsTransfer -Source https://x/a.zip -Destination D:\\a.zip'],
  ['bits positional+dest', 'Start-BitsTransfer https://x/a.zip -Destination D:\\a.zip'],
  ['bits bare positional', 'Start-BitsTransfer https://x/a.zip D:\\a.zip'],
  ['certutil split', 'certutil -urlcache -split -f https://x/a.zip D:\\a.zip'],
  ['wget alias in pwsh', 'wget https://x/a.zip -OutFile D:\\a.zip'],
]

for (const [name, command] of cases) {
  const plan = classify({ name: 'pwsh', arguments: { command } })
  const t = extractTargets(command, CWD)
  console.log(`${name.padEnd(24)} kind=${String(plan && plan.kind)} targets=${JSON.stringify(t)}`)
}
