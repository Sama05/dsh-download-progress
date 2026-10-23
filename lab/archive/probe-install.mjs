import { classify } from './detect.js'
const cases = [
  `npm install --registry=https://registry.npmmirror.com express mongoose axios lodash 2>&1 | Select-Object -Last 15`,
  `npm install express`,
  `pnpm add lodash`,
  `npm i react`,
  `pip install requests`,
]
for (const c of cases) {
  const plan = classify({ name: 'pwsh', arguments: { command: c } })
  console.log(JSON.stringify(c.slice(0,60)), '=>', plan ? JSON.stringify(plan) : 'null')
}
