/**
 * Verifica que `config/agents.json` coincida con la generación desde `src/agents.ts`.
 *
 * Uso:
 *   npm run agents:check
 *
 * Exit codes:
 *   0 → `config/agents.json` está sincronizado
 *   1 → hay diferencias (se imprime un diff legible; no se reescribe nada)
 */
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { renderAgents } from "./sync-agents"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const actualPath = join(root, "config/agents.json")

function printDiff(expected: string, actual: string): void {
  const expectedLines = expected.split("\n")
  const actualLines = actual.split("\n")
  const maxLines = Math.max(expectedLines.length, actualLines.length)

  console.error("Diferencias detectadas (línea: esperado | actual):")
  for (let i = 0; i < maxLines; i++) {
    const exp = expectedLines[i]
    const act = actualLines[i]
    if (exp !== act) {
      console.error(`--- línea ${i + 1} ---`)
      if (exp !== undefined) console.error(`- ${exp}`)
      if (act !== undefined) console.error(`+ ${act}`)
    }
  }
}

const expected = renderAgents().replace(/\r\n/g, "\n")
const actual = readFileSync(actualPath, "utf8").replace(/\r\n/g, "\n")

if (expected === actual) {
  console.log("config/agents.json coincide con src/agents.ts")
  process.exit(0)
} else {
  console.error("config/agents.json NO coincide con src/agents.ts")
  printDiff(expected, actual)
  process.exit(1)
}
