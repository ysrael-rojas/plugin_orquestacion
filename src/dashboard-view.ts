/**
 * View-model puro del dashboard de orquestaciones.
 *
 * No conoce HTTP ni el DOM: recibe `RunRecord[]` (tal como viven en
 * `ctx.storage`) y devuelve un estado de display listo para pintar. Toda la
 * presentación (glifos, textos redundantes, tiempos, tokens) se resuelve aquí
 * para que el HTML y el JS embebido solo se encarguen de la maquetación.
 */

import { formatTimeAgo, type ActivityItem, type DashboardActivitySource } from "./activity"
import type { RunRecord, TaskResult, TaskStatus } from "./types"

/** Versión del contrato de `/api/state`. Súbela si cambia la forma. */
export const DASHBOARD_STATE_VERSION = 2

/** Estado de display: unión del estado de run, de tarea y el implícito "pending". */
export type DisplayStatus = RunRecord["status"] | TaskStatus | "pending"

/** Tono visual; el color nunca es la única señal (siempre va glifo + texto). */
export type DisplayTone = "run" | "ok" | "failed" | "skipped" | "warn" | "aborted" | "pending"

export interface DashboardTaskRow {
  taskId: string
  agent: string
  status: DisplayStatus
  /** Glifo redundante con el texto ("⏳", "✅", "❌", "⏭️", "⚠️"). */
  glyph: string
  /** Texto legible del estado ("en curso", "completada", "falló"...). */
  statusText: string
  tone: DisplayTone
  /** true solo para tareas en vuelo (la vista pinta el spinner). */
  isRunning: boolean
  branch: string
  time: string
  /** Presente solo si la tarea reportó tokens. */
  tokens?: string
  /** Presente solo si la tarea reportó costo. */
  cost?: string
  summary: string
  /**
   * Últimas acciones reales de la tarea (hasta 8). Solo la llevan las tareas
   * en vuelo; las cerradas no incluyen la clave en `/api/state`.
   */
  activity?: DashboardActivityRow[]
}

/** Una acción ya formateada para pintar: tool + resumen + tiempo relativo. */
export interface DashboardActivityRow {
  tool: string
  summary: string
  /** Epoch ms del evento. */
  at: number
  /** Tiempo relativo ya formateado ("hace 5s", "hace 2m"). */
  ago: string
}

/** Actividad de la sesión orquestadora, con su etiqueta visible. */
export interface DashboardOrchestratorView {
  label: string
  activity: DashboardActivityRow[]
}

export interface DashboardRunView {
  runId: string
  objective: string
  status: RunRecord["status"]
  glyph: string
  statusText: string
  tone: DisplayTone
  baseBranch: string
  startedAt: string
  finishedAt?: string
  /** Duración legible ("12.4s", "1m 5s"...). */
  duration: string
  progressDone: number
  progressTotal: number
  /** "2/3", ya formateado para la cabecera. */
  progressLabel: string
  inFlight: string[]
  tasks: DashboardTaskRow[]
  /** Actividad de la sesión orquestadora (solo el run activo la incluye). */
  orchestrator?: DashboardOrchestratorView
  error?: string
  /** true para el run en curso (el que se pinta arriba). */
  isActive: boolean
}

export interface DashboardState {
  version: number
  generatedAt: string
  active: DashboardRunView | null
  /** Runs pasados, más recientes primero; se pintan dentro de un `<details>`. */
  history: DashboardRunView[]
  /** La columna tokens/costo solo se muestra si algún dato existe. */
  showTokens: boolean
  totals: {
    runs: number
    tasks: number
    running: number
  }
}

/**
 * Construye el estado de display a partir de los runs del storage.
 *
 * `activity` es opcional: sin fuente (o sin datos aún) las tareas en vuelo
 * llevan `activity: []` y el orquestador una lista vacía, nunca `null`.
 */
export function buildDashboardView(
  runs: readonly RunRecord[],
  now: Date = new Date(),
  activity?: DashboardActivitySource,
): DashboardState {
  const ordered = [...runs]
  const activeRecord = ordered.find((run) => run.status === "running")
  const active = activeRecord ? toRunView(activeRecord, now, true, activity) : null
  const history = ordered
    .filter((run) => run !== activeRecord)
    .map((run) => toRunView(run, now, false, activity))

  const views = active ? [active, ...history] : history

  return {
    version: DASHBOARD_STATE_VERSION,
    generatedAt: now.toISOString(),
    active,
    history,
    showTokens: views.some((view) => view.tasks.some((task) => task.tokens || task.cost)),
    totals: {
      runs: views.length,
      tasks: views.reduce((total, view) => total + view.tasks.length, 0),
      running: views.filter((view) => view.status === "running").length,
    },
  }
}

function toRunView(
  record: RunRecord,
  now: Date,
  isActive: boolean,
  activity?: DashboardActivitySource,
): DashboardRunView {
  const results = Array.isArray(record.results) ? record.results : []
  const inFlight = Array.isArray(record.inFlight) ? record.inFlight : []
  const done = results.length
  const total = typeof record.totalTasks === "number" && record.totalTasks >= 0 ? record.totalTasks : done
  const meta = runStatusMeta(record.status)

  return {
    runId: record.runId,
    objective: record.objective ?? "",
    status: record.status,
    glyph: meta.glyph,
    statusText: meta.text,
    tone: meta.tone,
    baseBranch: record.baseBranch ?? "",
    startedAt: record.startedAt ?? "",
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    duration: formatElapsed(record, now),
    progressDone: done,
    progressTotal: total,
    progressLabel: `${done}/${total}`,
    inFlight,
    tasks: buildTaskRows(results, inFlight, record.status, record.runId, now, activity),
    ...(isActive
      ? {
          orchestrator: {
            label: "orquestador",
            activity: toActivityRows(
              safeActivity(() => activity?.orchestrator(record.runId) ?? []),
              now,
            ),
          },
        }
      : {}),
    ...(record.error ? { error: record.error } : {}),
    isActive,
  }
}

function buildTaskRows(
  results: readonly TaskResult[],
  inFlight: readonly string[],
  runStatus: RunRecord["status"],
  runId: string,
  now: Date,
  activity?: DashboardActivitySource,
): DashboardTaskRow[] {
  const rows: DashboardTaskRow[] = results.map((result) => {
    const meta = taskStatusMeta(result.status)
    const tokens = formatTokens(result.tokens)
    const cost = formatCost(result.cost)
    return {
      taskId: result.taskId,
      agent: result.agent,
      status: result.status,
      glyph: meta.glyph,
      statusText: meta.text,
      tone: meta.tone,
      isRunning: false,
      branch: result.branch ?? "—",
      time: formatLatency(result.latencyMs),
      ...(tokens ? { tokens } : {}),
      ...(cost ? { cost } : {}),
      summary: result.summary ?? result.error ?? "",
    }
  })

  const closed = new Set(results.map((result) => result.taskId))
  for (const taskId of inFlight) {
    if (closed.has(taskId)) continue
    rows.push({
      taskId,
      agent: "—",
      status: "running",
      glyph: "⏳",
      statusText: metaText("running"),
      tone: "run",
      isRunning: true,
      branch: "—",
      time: "—",
      summary: "",
      activity: toActivityRows(safeActivity(() => activity?.task(runId, taskId) ?? []), now),
    })
  }

  // Un run cerrado no puede tener tareas "en curso": si quedó alguna en el
  // snapshot, es un run huérfano (servicio reiniciado) y no debe animarse.
  if (runStatus !== "running") {
    return rows.map((row) =>
      row.isRunning
        ? {
            ...row,
            status: "skipped" as const,
            glyph: "⏭️",
            statusText: "sin cerrar",
            tone: "skipped" as const,
            isRunning: false,
            activity: undefined,
          }
        : row,
    )
  }

  return rows
}

/** Convierte items crudos del feed en filas listas para pintar. */
function toActivityRows(
  items: readonly ActivityItem[],
  now: Date,
): DashboardActivityRow[] {
  return items.map((item) => ({
    tool: item.tool,
    summary: item.summary,
    at: item.at,
    ago: formatTimeAgo(item.at, now),
  }))
}

/** Lee la fuente de actividad sin permitir que un fallo rompa el dashboard. */
function safeActivity(load: () => readonly ActivityItem[]): readonly ActivityItem[] {
  try {
    const items = load()
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

function runStatusMeta(status: RunRecord["status"]): { glyph: string; text: string; tone: DisplayTone } {
  switch (status) {
    case "running":
      return { glyph: "⏳", text: "en curso", tone: "run" }
    case "completed":
      return { glyph: "✅", text: "completada", tone: "ok" }
    case "failed":
      return { glyph: "❌", text: "falló", tone: "failed" }
    case "aborted":
      return { glyph: "⏹️", text: "abortada", tone: "aborted" }
    default:
      return { glyph: "•", text: String(status), tone: "pending" }
  }
}

function taskStatusMeta(status: TaskStatus): { glyph: string; text: string; tone: DisplayTone } {
  switch (status) {
    case "succeeded":
      return { glyph: "✅", text: "completada", tone: "ok" }
    case "failed":
      return { glyph: "❌", text: "falló", tone: "failed" }
    case "skipped":
      return { glyph: "⏭️", text: "omitida", tone: "skipped" }
    case "unconfirmed":
      return { glyph: "⚠️", text: "sin confirmar", tone: "warn" }
    default:
      return { glyph: "•", text: String(status), tone: "pending" }
  }
}

function metaText(status: DisplayStatus): string {
  return status === "running" ? "en curso" : status
}

function formatElapsed(record: RunRecord, now: Date): string {
  const started = Date.parse(record.startedAt)
  if (!Number.isFinite(started)) return "—"
  const finished = record.finishedAt ? Date.parse(record.finishedAt) : now.getTime()
  if (!Number.isFinite(finished)) return "—"
  return formatDuration(Math.max(0, finished - started))
}

function formatLatency(latencyMs?: number): string {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) return "—"
  return formatDuration(latencyMs)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/**
 * Formatea tokens de orquestaciones reales: número, `{ input, output }`,
 * `{ total }` o cualquier objeto con contadores numéricos (se suman).
 */
export function formatTokens(tokens: unknown): string | undefined {
  const total = sumCounters(tokens, ["total", "input", "output", "reasoning", "cached", "cache"])
  if (total === undefined || total <= 0) return undefined
  return compactNumber(total)
}

/** Formatea el costo reportado por el proveedor (normalmente un número). */
export function formatCost(cost: unknown): string | undefined {
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    return `$${cost.toFixed(4)}`
  }
  if (cost && typeof cost === "object") {
    const total = sumCounters(cost, ["total", "amount", "value", "usd"])
    if (total !== undefined && total >= 0) return `$${total.toFixed(4)}`
  }
  return undefined
}

function sumCounters(value: unknown, keys: string[]): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (!value || typeof value !== "object") return undefined

  const record = value as Record<string, unknown>
  if (typeof record.total === "number" && Number.isFinite(record.total)) return record.total

  let sum = 0
  let found = false
  for (const [key, entry] of Object.entries(record)) {
    if (!keys.some((candidate) => key.toLowerCase().includes(candidate))) continue
    if (typeof entry === "number" && Number.isFinite(entry)) {
      sum += entry
      found = true
    }
  }
  return found ? sum : undefined
}

function compactNumber(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) {
    const thousands = value / 1000
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`
  }
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** Escapa texto para insertarlo en HTML (atributos y contenido). */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Reexport del formateador relativo usado por las filas de actividad
 * ("hace 5s", "hace 2m"): la vista y `run_status` comparten formato.
 */
export { formatTimeAgo }
export type { ActivityItem, DashboardActivitySource }
