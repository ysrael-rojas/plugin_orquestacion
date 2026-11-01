/**
 * Genera `config/agents.json` desde `src/agents.ts` (fuente única de verdad).
 *
 * Uso:
 *   npm run agents:sync      → regenera config/agents.json
 *   npm run agents:install   → además fusiona los agentes en el opencode.json global
 *
 * Variable de entorno:
 *   OPENCODE_CONFIG → ruta explícita del opencode.json (por defecto ~/.config/opencode/opencode.json)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { AGENTS } from "../src/agents"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Renderiza el contenido exacto que debe tener `config/agents.json`. */
export function renderAgents(): string {
  return JSON.stringify(AGENTS, null, 2) + "\n"
}

function isMain(): boolean {
  const mainPath = process.argv[1]
  if (!mainPath) return false
  return mainPath.endsWith("sync-agents.mjs") || mainPath.endsWith("sync-agents.ts")
}

function run(): void {
  const install = process.argv.includes("--install")

  writeFileSync(join(root, "config/agents.json"), renderAgents())
  console.log("config/agents.json generado desde src/agents.ts")

  if (install) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
    const configPath = process.env.OPENCODE_CONFIG ?? join(home, ".config", "opencode", "opencode.json")

    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>
    config.agents = { ...(config.agents ?? {}), ...AGENTS }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
    console.log(`agentes instalados en ${configPath}`)
  }
}

if (isMain()) {
  run()
}
