/**
 * Renderizador y escritor de documentos de plan (`docs/plans/<runId>.md`).
 *
 * Cada orquestación genera un Markdown vivo con:
 *  - frontmatter YAML (runId, objective, status, baseBranch, timestamps)
 *  - sección de contexto
 *  - tabla de tareas con estado
 *  - línea de summary por tarea
 *
 * Las escrituras de actualización son best-effort: nunca rompen el run.
 * La escritura inicial es fail-hard para detectar problemas de permisos
 * antes de crear sesiones hijas.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize } from "node:path"

import type { PlanDocsState, RunRecord, TaskStatus } from "./types"

export interface PlanDocsWriter {
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>
  writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>
}

const defaultWriter: PlanDocsWriter = {
  mkdir,
  writeFile,
}

/** Ruta absoluta del archivo de plan. */
export function planDocsFilePath(state: Pick<PlanDocsState, "workdir" | "folder" | "runId">): string {
  return join(state.workdir, state.folder, `${state.runId}.md`)
}

/** Ruta relativa con barras normales, útil para mostrar en UI. */
export function planDocsRelativePath(state: Pick<PlanDocsState, "folder" | "runId">): string {
  return `${state.folder}/${state.runId}.md`.replace(/\\/g, "/")
}

/** Sanitiza la carpeta destino: solo subcarpetas relativas dentro del repo. */
export function sanitizePlanDocsFolder(raw: string): string {
  if (typeof raw !== "string") return "docs/plans"
  const cleaned = raw.trim().replace(/\\/g, "/")
  if (!cleaned) return "docs/plans"
  if (isAbsolute(cleaned)) return "docs/plans"

  const rawParts = cleaned.split("/").filter((part) => part !== "")
  if (rawParts.length === 0) return "docs/plans"
  if (rawParts.some((part) => part === "..")) return "docs/plans"

  const normal = normalize(rawParts.join("/")).replace(/\\/g, "/")
  if (isAbsolute(normal)) return "docs/plans"

  const parts = normal.split("/").filter(Boolean)
  if (parts.length === 0) return "docs/plans"
  if (parts.some((part) => part === "..")) return "docs/plans"

  return parts.join("/")
}

/** Escribe el documento de plan. Los errores se propagan (fail-hard solo en el arranque). */
export async function writePlanDocs(
  state: PlanDocsState,
  writer: PlanDocsWriter = defaultWriter,
): Promise<void> {
  const filePath = planDocsFilePath(state)
  await writer.mkdir(dirname(filePath), { recursive: true })
  await writer.writeFile(filePath, renderPlanMarkdown(state), "utf8")
}

/** Renderiza el Markdown completo del plan. */
export function renderPlanMarkdown(state: PlanDocsState): string {
  const lines: string[] = []

  lines.push("---")
  lines.push(`runId: ${yamlValue(state.runId)}`)
  lines.push(`objective: ${yamlValue(state.objective)}`)
  lines.push(`status: ${yamlValue(state.status)}`)
  lines.push(`baseBranch: ${yamlValue(state.baseBranch)}`)
  lines.push(`startedAt: ${yamlValue(state.startedAt)}`)
  if (state.finishedAt) {
    lines.push(`finishedAt: ${yamlValue(state.finishedAt)}`)
  }
  lines.push("---")
  lines.push("")

  lines.push("## Contexto")
  lines.push("")
  lines.push(state.contextSummary?.trim() || "(sin contexto adicional)")
  lines.push("")

  lines.push("## Tareas")
  lines.push("")
  lines.push("| ID | Agente | Estado | Rama | Depende de |")
  lines.push("|---|---|---|---|---|")
  for (const task of state.tasks) {
    const status = taskStatusForPlan(state, task.id)
    const branch = task.branch ? inlineCode(task.branch) : "—"
    const deps = task.dependsOn?.length ? task.dependsOn.join(", ") : "—"
    lines.push(
      `| ${escapeCell(task.id)} | ${escapeCell(task.agent)} | ${statusIcon(status)} ${status} | ${branch} | ${escapeCell(deps)} |`,
    )
  }
  lines.push("")

  lines.push("## Avance por tarea")
  lines.push("")
  for (const task of state.tasks) {
    const status = taskStatusForPlan(state, task.id)
    const result = state.results.find((entry) => entry.taskId === task.id)
    const summary = result?.summary?.trim() || "(sin resumen)"
    lines.push(`- **${escapeCell(task.id)}** (${statusIcon(status)} ${status}): ${escapeCell(summary)}`)
  }
  lines.push("")

  return lines.join("\n")
}

function taskStatusForPlan(state: PlanDocsState, taskId: string): TaskStatus | "running" {
  const result = state.results.find((entry) => entry.taskId === taskId)
  if (result) return result.status
  if (state.inFlight.includes(taskId)) return "running"
  return "skipped"
}

/** Icono visual para un estado de run o tarea. */
export function statusIcon(status: RunRecord["status"] | TaskStatus | "running"): string {
  switch (status) {
    case "running":
      return "⏳"
    case "completed":
    case "succeeded":
      return "✅"
    case "failed":
      return "❌"
    case "skipped":
      return "⏭️"
    case "unconfirmed":
      return "⚠️"
    case "aborted":
      return "⏹️"
    default:
      return "•"
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

function inlineCode(value: string): string {
  const escaped = value.replace(/`/g, "\\`")
  return `\`${escaped}\``
}

function yamlValue(value: string | undefined): string {
  if (value === undefined) return '""'
  const needsQuotes =
    value.length === 0 ||
    /[\n:\-[\]{}#&*!?|>'"%@`,]/.test(value) ||
    /^\s/.test(value) ||
    /\s$/.test(value) ||
    ["true", "false", "null", "~", "yes", "no", "on", "off"].includes(value.toLowerCase())

  if (!needsQuotes) return value

  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
  return `"${escaped}"`
}
