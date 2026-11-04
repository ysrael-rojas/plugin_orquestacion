import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Regenera `skills-lock.json` (lock de proyecto v1 del CLI `vercel-labs/skills`)
 * para las skills vendorizadas en `.agents/skills/`.
 *
 * El formato del lock es el del CLI:
 *   computedHash = sha256 de (ruta relativa + bytes) de cada archivo de la
 *   carpeta de la skill, ordenados con `localeCompare`, sin separadores.
 *
 * Ojo: el hash es byte a byte. Depende de los finales de línea del checkout
 * (CRLF en Windows, LF en Linux/CI), así que un hash distinto entre plataformas
 * es drift esperado del lock, no un cambio de contenido.
 */

const SKILLS_DIR = path.join(process.cwd(), ".agents", "skills")
const LOCK_PATH = path.join(process.cwd(), "skills-lock.json")
const SOURCE = "mattpocock/skills"

/** Skills que viven bajo `skills/productivity/` upstream; el resto son de `skills/engineering/`. */
const PRODUCTIVITY = new Set(["grill-me", "grilling", "writing-for-agents"])

async function collectFiles(baseDir, currentDir, out) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      await collectFiles(baseDir, fullPath, out)
    } else if (entry.isFile()) {
      out.push({
        relativePath: path.relative(baseDir, fullPath).split("\\").join("/"),
        content: await readFile(fullPath),
      })
    }
  }
}

async function folderHash(skillDir) {
  const files = []
  await collectFiles(skillDir, skillDir, files)
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file.relativePath)
    hash.update(file.content)
  }
  return hash.digest("hex")
}

async function readExistingLock() {
  try {
    return JSON.parse(await readFile(LOCK_PATH, "utf-8")).skills ?? {}
  } catch {
    return {}
  }
}

const existing = await readExistingLock()
const entries = await readdir(SKILLS_DIR, { withFileTypes: true })
const names = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const skills = {}
for (const name of names) {
  const group = PRODUCTIVITY.has(name) ? "productivity" : "engineering"
  skills[name] = {
    source: SOURCE,
    sourceType: "github",
    skillPath: `skills/${group}/${name}/SKILL.md`,
    computedHash: await folderHash(path.join(SKILLS_DIR, name)),
  }
}

await writeFile(LOCK_PATH, `${JSON.stringify({ version: 1, skills }, null, 2)}\n`, "utf-8")

const changed = names.filter((name) => existing[name]?.computedHash !== skills[name].computedHash)
const removed = Object.keys(existing).filter((name) => !(name in skills))

console.log(`skills-lock.json: ${names.length} entradas`)
if (changed.length > 0) console.log(`  actualizadas: ${changed.join(", ")}`)
if (removed.length > 0) console.log(`  eliminadas: ${removed.join(", ")}`)
