import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import type { PluginCtx } from "./types"

export interface RegisterSkillsOptions {
  /** Si es `false`, no registra ninguna skill. Default `true`. */
  enabled?: boolean
  /** Directorio base del plugin; por defecto usa `ctx.location.directory`. */
  workdir?: string
}

interface Skill {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  content: string
}

interface ParsedSkill extends Skill {}

interface SkillEditor {
  add(skill: Skill): void
}

interface SkillDomain {
  transform(callback: (editor: SkillEditor) => void): Promise<{ dispose: () => Promise<void> }>
}

interface PluginCtxWithSkills extends PluginCtx {
  skill?: SkillDomain
}

/**
 * Registra automáticamente las skills del catálogo `.agents/skills/` usando
 * `ctx.skill.transform` -> `SkillEditor.add`.
 *
 * Cada subdirectorio se interpreta como el ID de la skill y debe contener un
 * `SKILL.md` con frontmatter YAML (`name`, `description`,
 * `disable-model-invocation`). Si `disable-model-invocation` es `true`, se
 * registra con `autoinvoke: false` (solo invocable explícitamente).
 *
 * Las claves opcionales (`description`, `autoinvoke`) se **omiten** cuando no
 * tienen valor: el esquema de OpenCode (Effect Schema, clave opcional) rechaza
 * una clave presente con valor `undefined` ("Expected boolean"), lo que
 * deshabilita el plugin entero.
 */
export async function registerSkills(
  ctx: PluginCtx,
  options: RegisterSkillsOptions = {},
): Promise<{ dispose?: () => Promise<void> } | undefined> {
  if (options.enabled === false) {
    return undefined
  }

  const skillDomain = (ctx as PluginCtxWithSkills).skill
  if (typeof skillDomain?.transform !== "function") {
    console.warn("[plugin-orquestacion] ctx.skill.transform no está disponible; las skills no se registrarán.")
    return undefined
  }

  const workdir = options.workdir ?? ctx.location?.directory ?? process.cwd()
  const skillsDir = path.join(workdir, ".agents", "skills")

  const skills = await loadSkillsFromDirectory(skillsDir)
  if (skills.length === 0) {
    return undefined
  }

  return skillDomain.transform((editor: SkillEditor) => {
    for (const skill of skills) {
      editor.add({
        id: skill.id,
        name: skill.name,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
        path: skill.path,
        content: skill.content,
      })
    }
  })
}

async function loadSkillsFromDirectory(skillsDir: string): Promise<ParsedSkill[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    // El catálogo no existe; no es un error fatal.
    return []
  }

  const skills: ParsedSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const skillPath = path.join(skillsDir, entry.name, "SKILL.md")
    let raw: string
    try {
      raw = await readFile(skillPath, "utf-8")
    } catch {
      console.warn(`[plugin-orquestacion] No se encontró ${skillPath}; se omite la skill ${entry.name}.`)
      continue
    }

    const parsed = parseSkillMarkdown(raw)
    skills.push({
      id: entry.name,
      name: parsed.name ?? entry.name,
      description: parsed.description,
      autoinvoke: parsed["disable-model-invocation"] === true ? false : undefined,
      path: skillPath,
      content: parsed.content,
    })
  }

  return skills
}

function parseSkillMarkdown(raw: string): {
  name?: string
  description?: string
  "disable-model-invocation"?: boolean
  content: string
} {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(raw)
  if (!match) {
    return { content: raw.trim() }
  }

  const frontmatter = match[1]!
  const content = match[2]!.trim()
  const result: Record<string, unknown> = { content }

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const separatorIndex = trimmed.indexOf(":")
    if (separatorIndex === -1) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    let value: unknown = trimmed.slice(separatorIndex + 1).trim()

    // Quita comillas envolventes si las hay.
    if (typeof value === "string" && value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }

    if (key === "disable-model-invocation") {
      value = value === "true" || value === true
    }

    result[key] = value
  }

  return {
    name: typeof result.name === "string" ? result.name : undefined,
    description: typeof result.description === "string" ? result.description : undefined,
    "disable-model-invocation": result["disable-model-invocation"] === true ? true : undefined,
    content,
  }
}
