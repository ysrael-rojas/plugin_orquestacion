/**
 * View-model puro del dashboard de orquestaciones (contrato v4: árbol).
 *
 * No conoce HTTP ni el DOM: recibe `RunRecord[]` (tal como viven en
 * `ctx.storage`) y devuelve un estado de display listo para pintar. Toda la
 * presentación (glifos, títulos cortos, chips agente·modelo, tiempos, tokens)
 * se resuelve aquí para que el HTML y el JS embebido solo maqueten.
 *
 * Tolerancia deliberada: el contrato v4 (título corto, modelo y sub-sesiones)
 * se implementa leyendo los campos de forma defensiva. Si un run viene del
 * contrato anterior (sin `title`, sin `model`, con `inFlight: string[]`) el
 * árbol se pinta igual con fallbacks y sin romper nada.
 */

import { formatTimeAgo, type ActivityItem, type DashboardActivitySource } from "./activity"
import { isQaLevel } from "./contracts"
import type { QaLevel, RunRecord, TaskResult, TaskStatus } from "./types"

/** Versión del contrato de `/api/state`. v4 = árbol (title, model, sub-sesiones). */
export const DASHBOARD_STATE_VERSION = 4

/** Estado de display: unión del estado de run, de tarea y el implícito "pending". */
export type DisplayStatus = RunRecord["status"] | TaskStatus | "pending"

/** Tono visual; el color nunca es la única señal (siempre va glifo + texto). */
export type DisplayTone = "run" | "ok" | "failed" | "skipped" | "warn" | "aborted" | "pending"

/**
 * Nodo de sub-sesión del árbol (sesiones nietas: subagentes de un subagente).
 *
 * Es la **única** definición del nodo: `/api/state` la importa de aquí. La
 * cascada canónica vive en `children` (lo que pinta el HTML, tanto en el
 * servidor como en el refresco del cliente) y `subsessions` la publica como
 * alias con el nombre del contrato v4.
 */
export interface DashboardSessionNode {
  /** ID de la sesión (o el que reporte el runtime). */
  id: string
  /** Título corto del nodo (nunca vacío: cae al agente o a un ID recortado). */
  title: string
  /** Agente que atiende la sesión. */
  agent: string
  /** Modelo efectivo; ausente si el runtime no lo reportó. */
  model?: string
  status: DisplayStatus
  glyph: string
  statusText: string
  tone: DisplayTone
  /** Rol del nodo en el run ("orchestrator", "task", "sub"), si se conoce. */
  role?: string
  /** Tarea dueña del nodo, si el runtime lo reportó. */
  taskId?: string
  /**
   * Últimas acciones de la sesión. Solo `/api/state` la rellena: la vista lee
   * la actividad de su propia fuente y no necesita duplicarla.
   */
  activity?: DashboardActivityRow[]
  /** Sub-sesiones anidadas (cascada por `parentID`). */
  children: DashboardSessionNode[]
  /** Alias de `children` con el nombre que usa el contrato `/api/state` v4. */
  subsessions?: DashboardSessionNode[]
}

export interface DashboardTaskRow {
  taskId: string
  /** Título corto (fallback: primera línea del summary o el propio ID). */
  title: string
  agent: string
  /** Modelo efectivo de la tarea; ausente si no se conoce. */
  model?: string
  /** Nivel de QA efectivo (L1/L2/L3); presente solo si la tarea lo reporta. */
  qaLevel?: QaLevel
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
  /** Sub-sesiones (subagentes de la tarea) anidadas bajo el nodo. */
  subsessions?: DashboardSessionNode[]
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

/** Nodo raíz del run: la sesión orquestadora. */
export interface DashboardOrchestratorView {
  /** Rol visible ("orquestador"). */
  label: string
  /** Agente de la sesión orquestadora, si el runtime lo reportó. */
  agent?: string
  /** Modelo de la sesión orquestadora, si se conoce. */
  model?: string
  activity: DashboardActivityRow[]
  /** Sub-sesiones que cuelgan directo del orquestador (sin tarea asociada). */
  subsessions?: DashboardSessionNode[]
}

export interface DashboardRunView {
  runId: string
  /** Título corto del run (fallback: primera línea del objetivo). */
  title: string
  /** Objetivo completo (va en un `<details>` para no ensuciar el árbol). */
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
  /** Línea compacta del historial: "título · 31 dic 00:00 · completada · 1/1". */
  compact: string
  progressDone: number
  progressTotal: number
  /** "2/3", ya formateado para la cabecera. */
  progressLabel: string
  /**
   * Nombre del perfil de modelos con el que corrió el run (`high`, `balanced`,
   * `low`, `free` o uno personalizado). Ausente si el run no declaró perfil o
   * si `/api/state` viene de un backend sin perfiles.
   */
  modelProfile?: string
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
  /** Runs pasados, más recientes primero; se pintan como línea compacta. */
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
  const inFlight = normalizeInFlight(record)
  const done = results.length
  const total = typeof record.totalTasks === "number" && record.totalTasks >= 0 ? record.totalTasks : done
  const meta = runStatusMeta(record.status)
  const title = runTitle(record)
  const modelProfile = runModelProfile(record)
  const rows = buildTaskRows(results, inFlight, record.status, record.runId, now, activity)
  const forest = buildSessionForest(readRunSessions(record), results, inFlight, rows)
  const tasks = rows.map((row) => {
    const subsessions = forest.byTask.get(row.taskId)
    return subsessions && subsessions.length > 0 ? { ...row, subsessions } : row
  })
  const orchestrator = isActive ? buildOrchestratorView(record, now, activity, forest) : undefined

  return {
    runId: record.runId,
    title,
    objective: record.objective ?? "",
    status: record.status,
    glyph: meta.glyph,
    statusText: meta.text,
    tone: meta.tone,
    baseBranch: record.baseBranch ?? "",
    startedAt: record.startedAt ?? "",
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    duration: formatElapsed(record, now),
    compact: [title, formatStamp(record.startedAt ?? ""), meta.text, `${done}/${total}`].join(" · "),
    progressDone: done,
    progressTotal: total,
    progressLabel: `${done}/${total}`,
    ...(modelProfile ? { modelProfile } : {}),
    inFlight: inFlight.map((entry) => entry.taskId),
    tasks,
    ...(orchestrator ? { orchestrator } : {}),
    ...(record.error ? { error: record.error } : {}),
    isActive,
  }
}

/** Nodo orquestador del árbol: rol + agente/modelo (si se conocen) + actividad. */
function buildOrchestratorView(
  record: RunRecord,
  now: Date,
  activity: DashboardActivitySource | undefined,
  forest: SessionForest,
): DashboardOrchestratorView {
  const nested = forest.roots
  return {
    label: "orquestador",
    ...(forest.agent ? { agent: forest.agent } : {}),
    ...(forest.model ? { model: forest.model } : {}),
    activity: toActivityRows(safeActivity(() => activity?.orchestrator(record.runId) ?? []), now),
    ...(nested.length > 0 ? { subsessions: nested } : {}),
  }
}

function buildTaskRows(
  results: readonly TaskResult[],
  inFlight: readonly InFlightEntry[],
  runStatus: RunRecord["status"],
  runId: string,
  now: Date,
  activity?: DashboardActivitySource,
): DashboardTaskRow[] {
  const rows: DashboardTaskRow[] = results.map((result) => {
    const meta = taskStatusMeta(result.status)
    const tokens = formatTokens(result.tokens)
    const cost = formatCost(result.cost)
    const model = readModel(result)
    return {
      taskId: result.taskId,
      title: taskTitle(result),
      agent: result.agent,
      ...(model ? { model } : {}),
      ...(isQaLevel(result.qaLevel) ? { qaLevel: result.qaLevel } : {}),
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
  for (const entry of inFlight) {
    if (closed.has(entry.taskId)) continue
    rows.push({
      taskId: entry.taskId,
      title: entry.title || entry.taskId,
      agent: entry.agent || "—",
      ...(entry.model ? { model: entry.model } : {}),
      status: "running",
      glyph: "⏳",
      statusText: metaText("running"),
      tone: "run",
      isRunning: true,
      branch: entry.branch || "—",
      time: formatInFlight(entry, now),
      summary: "",
      activity: toActivityRows(safeActivity(() => activity?.task(runId, entry.taskId) ?? []), now),
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

/** Tarea en vuelo del contrato v4; el v3 (array de strings) se normaliza aquí. */
interface InFlightEntry {
  taskId: string
  title: string
  agent: string
  model?: string
  branch: string
  startedAt: string
  sessionID?: string
}

function normalizeInFlight(record: RunRecord): InFlightEntry[] {
  const raw = (record as unknown as Record<string, unknown>).inFlight
  if (!Array.isArray(raw)) return []

  const entries: InFlightEntry[] = []
  for (const entry of raw) {
    if (typeof entry === "string") {
      const taskId = entry.trim()
      if (taskId) entries.push({ taskId, title: taskId, agent: "—", branch: "—", startedAt: "" })
      continue
    }
    const recordEntry = asRecord(entry)
    if (!recordEntry) continue
    const taskId = firstText(recordEntry, ["taskId", "taskID", "id"])
    if (!taskId) continue
    const model = formatModelLabel(recordEntry.model)
    const sessionID = firstText(recordEntry, ["sessionID", "sessionId"])
    entries.push({
      taskId,
      title: shortText(recordEntry.title, TASK_TITLE_MAX) || taskId,
      agent: firstText(recordEntry, ["agent", "agentName"]) || "—",
      ...(model ? { model } : {}),
      branch: firstText(recordEntry, ["branch"]) || "—",
      startedAt: firstText(recordEntry, ["startedAt", "startedAtIso"]),
      ...(sessionID ? { sessionID } : {}),
    })
  }
  return entries
}

/** Duración de una tarea en vuelo desde su `startedAt` (si lo trae). */
function formatInFlight(entry: InFlightEntry, now: Date): string {
  const started = Date.parse(entry.startedAt)
  if (!Number.isFinite(started)) return "—"
  return formatDuration(Math.max(0, now.getTime() - started))
}

// ---------------------------------------------------------------------------
// Sub-sesiones: lectura tolerante + cascada por `parentID`
// ---------------------------------------------------------------------------

/** Claves donde el contrato v4 puede colgar la lista de sesiones del run. */
const SESSION_LIST_KEYS = ["subsessions", "subSessions", "sessions", "sessionTree", "descendants"] as const
/** Claves de hijos dentro de un nodo de sesión. */
const SESSION_CHILD_KEYS = ["subsessions", "subSessions", "sessions", "children"] as const
/** Claves del título corto. */
const TITLE_KEYS = ["title", "shortTitle"] as const
/** Claves donde el contrato puede colgar el nombre del perfil de modelos. */
const PROFILE_KEYS = ["modelProfile", "modelProfileName", "profile"] as const

const TASK_TITLE_MAX = 70
const RUN_TITLE_MAX = 90
const MAX_CASCADE_HOPS = 10
const MAX_CASCADE_DEPTH = 6

interface RawSession {
  id: string
  parentID: string
  taskId: string
  role: string
  title: string
  agent: string
  model?: string
  status: string
  startedAt: string
}

interface SessionForest {
  byTask: Map<string, DashboardSessionNode[]>
  roots: DashboardSessionNode[]
  agent?: string
  model?: string
}

function emptyForest(): SessionForest {
  return { byTask: new Map(), roots: [] }
}

function readRunSessions(record: RunRecord): RawSession[] {
  const source = record as unknown as Record<string, unknown>
  for (const key of SESSION_LIST_KEYS) {
    const nodes = readSessionNodes(source[key])
    if (nodes.length > 0) return nodes
  }
  return []
}

/** Aplana un árbol de sesiones (array u objeto con hijos) a nodos con `parentID`. */
function readSessionNodes(value: unknown, parentID = "", depth = 0): RawSession[] {
  if (!Array.isArray(value) || depth > MAX_CASCADE_DEPTH) return []

  const nodes: RawSession[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    const id = firstText(record, ["sessionID", "sessionId", "id"])
    if (!id) continue

    const nodeParent = firstText(record, ["parentID", "parentId", "parentSessionID", "parent"]) || parentID
    const model = formatModelLabel(record.model)
    nodes.push({
      id,
      parentID: nodeParent,
      taskId: firstText(record, ["taskId", "taskID"]),
      role: firstText(record, ["role"]),
      title: firstText(record, TITLE_KEYS),
      agent: firstText(record, ["agent", "agentName"]),
      ...(model ? { model } : {}),
      status: firstText(record, ["status", "state"]),
      startedAt: firstText(record, ["startedAt", "createdAt"]),
    })

    for (const key of SESSION_CHILD_KEYS) {
      const children = readSessionNodes(record[key], id, depth + 1)
      if (children.length > 0) {
        nodes.push(...children)
        break
      }
    }
  }
  return nodes
}

/**
 * Construye el bosque de sub-sesiones:
 * - las que cuelgan de una tarea (por `taskId` o por el `sessionID` de la tarea)
 *   se anidan bajo ese nodo de tarea;
 * - las que cuelgan de otra sesión se anidan bajo ella (cascada real);
 * - el resto cuelga del orquestador.
 */
function buildSessionForest(
  raw: readonly RawSession[],
  results: readonly TaskResult[],
  inFlight: readonly InFlightEntry[],
  tasks: readonly DashboardTaskRow[],
): SessionForest {
  if (raw.length === 0) return emptyForest()

  const taskIds = new Set(tasks.map((task) => task.taskId))
  const taskSessionIds = new Map<string, string>()
  for (const result of results) {
    const sessionID = typeof result.sessionID === "string" ? result.sessionID.trim() : ""
    if (sessionID) taskSessionIds.set(sessionID, result.taskId)
  }
  for (const entry of inFlight) {
    const sessionID = readInFlightSessionID(entry)
    if (sessionID && !taskSessionIds.has(sessionID)) taskSessionIds.set(sessionID, entry.taskId)
  }

  const nodes = new Map<string, DashboardSessionNode>()
  const rawById = new Map<string, RawSession>()
  const ordered = [...raw].sort(compareSessions)
  for (const session of ordered) {
    if (!rawById.has(session.id)) rawById.set(session.id, session)
  }

  const forest = emptyForest()
  for (const session of ordered) {
    if (session.role === "orchestrator") {
      // La sesión orquestadora es la raíz del árbol, no un nodo hijo.
      if (!forest.agent && session.agent) forest.agent = session.agent
      if (!forest.model && session.model) forest.model = session.model
      continue
    }
    // La sesión propia de una tarea ya está representada por la fila de la
    // tarea: se omite el nodo, pero sus hijas se cuelgan de la tarea.
    if (taskSessionIds.has(session.id)) continue
    if (nodes.has(session.id)) continue
    nodes.set(session.id, toSessionNode(session))
  }

  const parentOf = new Map<string, string>()

  /** Sube por la cadena de padres hasta la tarea o el nodo visible dueño. */
  const ownerOf = (session: RawSession): { taskId?: string; parentId?: string } => {
    if (session.taskId) return { taskId: session.taskId }
    let current = session.parentID
    const seen = new Set<string>()
    for (let hop = 0; hop < MAX_CASCADE_HOPS; hop++) {
      if (!current || seen.has(current)) return {}
      seen.add(current)
      const taskId = taskSessionIds.get(current)
      if (taskId) return { taskId }
      if (nodes.has(current)) return { parentId: current }
      const parentRaw = rawById.get(current)
      if (!parentRaw) return {}
      current = parentRaw.parentID
    }
    return {}
  }

  for (const session of ordered) {
    const node = nodes.get(session.id)
    if (!node) continue

    const owner = ownerOf(session)
    if (owner.taskId) {
      if (taskIds.has(owner.taskId)) {
        appendToBuckets(forest.byTask, owner.taskId, node)
        continue
      }
      // La tarea ya no está en el snapshot: el nodo cuelga del orquestador.
      forest.roots.push(node)
      continue
    }

    if (owner.parentId && owner.parentId !== session.id && !wouldCycle(parentOf, owner.parentId, session.id)) {
      const parent = nodes.get(owner.parentId)
      if (parent) {
        parent.children.push(node)
        parentOf.set(session.id, owner.parentId)
        continue
      }
    }

    forest.roots.push(node)
  }

  return forest
}

/** Orden cronológico por `startedAt` y, si empatan o falta, por id. */
function compareSessions(left: RawSession, right: RawSession): number {
  const leftTime = Date.parse(left.startedAt)
  const rightTime = Date.parse(right.startedAt)
  const leftValid = Number.isFinite(leftTime)
  const rightValid = Number.isFinite(rightTime)
  if (leftValid && rightValid && leftTime !== rightTime) return leftTime - rightTime
  if (leftValid !== rightValid) return leftValid ? -1 : 1
  return left.id.localeCompare(right.id)
}

function readInFlightSessionID(entry: InFlightEntry): string {
  return (entry.sessionID ?? "").trim()
}

function appendToBuckets(
  buckets: Map<string, DashboardSessionNode[]>,
  key: string,
  node: DashboardSessionNode,
): void {
  const bucket = buckets.get(key)
  if (bucket) bucket.push(node)
  else buckets.set(key, [node])
}

/** Evita ciclos si el runtime reporta `parentID` inconsistentes. */
function wouldCycle(parentOf: Map<string, string>, parentId: string, childId: string): boolean {
  let current: string | undefined = parentId
  const seen = new Set<string>()
  for (let hop = 0; hop < MAX_CASCADE_HOPS && current; hop++) {
    if (current === childId || seen.has(current)) return true
    seen.add(current)
    current = parentOf.get(current)
  }
  return false
}

function toSessionNode(session: RawSession): DashboardSessionNode {
  const meta = sessionStatusMeta(session.status)
  return {
    id: session.id,
    title: session.title || fallbackSessionTitle(session),
    agent: session.agent || "—",
    ...(session.model ? { model: session.model } : {}),
    status: meta.status,
    glyph: meta.glyph,
    statusText: meta.text,
    tone: meta.tone,
    children: [],
  }
}

function fallbackSessionTitle(session: RawSession): string {
  const id = session.id.length > 12 ? session.id.slice(0, 12) : session.id
  return session.agent ? `${session.agent} · ${id}` : `sesión ${id}`
}

// ---------------------------------------------------------------------------
// Formato de agentes, modelos y títulos
// ---------------------------------------------------------------------------

/** "agente · modelo" (el chip de cada nodo). Si falta el modelo, solo el agente. */
export function formatChip(agent: string, model?: string): string {
  const name = (agent ?? "").trim() || "—"
  const suffix = (model ?? "").trim()
  return suffix ? `${name} · ${suffix}` : name
}

/**
 * Normaliza el modelo de un nodo: string, `{ providerID, id }` o cualquier
 * objeto con `id`/`modelID`. Devuelve `undefined` si no hay dato utilizable.
 */
export function formatModelLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    return text || undefined
  }
  const record = asRecord(value)
  if (!record) return undefined

  const id = firstText(record, ["id", "modelID", "modelId"])
  const provider = firstText(record, ["providerID", "providerId", "provider"])
  if (!id) {
    const nested = typeof record.model === "string" ? record.model.trim() : ""
    return nested || provider || undefined
  }
  if (!provider || id.includes("/")) return id
  return `${provider}/${id}`
}

function readModel(result: TaskResult): string | undefined {
  return formatModelLabel((result as unknown as Record<string, unknown>).model)
}

/**
 * Perfil de modelos del run, leído de forma tolerante.
 *
 * Acepta el formato que emita el backend: string (`"balanced"`) u objeto con el
 * nombre (`{ name }`, `{ id }`, `{ profile }`). Sin dato devuelve `undefined`,
 * así el dashboard sigue pintando estados antiguos (sin perfiles) igual que
 * antes y no muestra badge.
 */
export function readModelProfile(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    return text || undefined
  }
  const record = asRecord(value)
  if (!record) return undefined
  const name = firstText(record, ["name", "id", "profile", "modelProfile", "label"])
  return name || undefined
}

function runModelProfile(record: RunRecord): string | undefined {
  const source = record as unknown as Record<string, unknown>
  for (const key of PROFILE_KEYS) {
    const profile = readModelProfile(source[key])
    if (profile) return profile
  }
  return undefined
}

function runTitle(record: RunRecord): string {
  const explicit = firstText(record as unknown as Record<string, unknown>, TITLE_KEYS)
  if (explicit) return shortText(explicit, RUN_TITLE_MAX)
  return shortText(record.objective, RUN_TITLE_MAX) || record.runId
}

function taskTitle(result: TaskResult): string {
  const source = result as unknown as Record<string, unknown>
  const explicit = firstText(source, TITLE_KEYS)
  if (explicit) return shortText(explicit, TASK_TITLE_MAX)
  return shortText(result.summary ?? result.error, TASK_TITLE_MAX) || result.taskId
}

/** Primera línea de un texto, con espacios colapsados y recorte con elipsis. */
export function shortText(value: unknown, max = RUN_TITLE_MAX): string {
  if (value === undefined || value === null) return ""
  const firstLine = String(value).split(/\r?\n/)[0] ?? ""
  const clean = firstLine.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const

/** Fecha compacta y estable para el historial: "31 dic 00:00" (UTC). */
export function formatStamp(iso: string): string {
  const time = Date.parse(iso ?? "")
  if (!Number.isFinite(time)) return "—"
  const date = new Date(time)
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = MONTHS[date.getUTCMonth()] ?? ""
  const hours = String(date.getUTCHours()).padStart(2, "0")
  const minutes = String(date.getUTCMinutes()).padStart(2, "0")
  return `${day} ${month} ${hours}:${minutes}`
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

/** Estado de una sub-sesión: el runtime usa valores heterogéneos ("idle", "busy"...). */
export function sessionStatusMeta(status: string): {
  status: DisplayStatus
  glyph: string
  text: string
  tone: DisplayTone
} {
  const value = (status ?? "").toLowerCase()
  if (value === "running" || value === "active" || value === "busy" || value === "retry") {
    return { status: "running", glyph: "⏳", text: "en curso", tone: "run" }
  }
  if (value === "completed" || value === "done" || value === "idle" || value === "ready") {
    return { status: "succeeded", glyph: "✅", text: "cerrada", tone: "ok" }
  }
  if (value === "error" || value === "failed") {
    return { status: "failed", glyph: "❌", text: "falló", tone: "failed" }
  }
  if (value === "aborted" || value === "cancelled" || value === "canceled") {
    return { status: "aborted", glyph: "⏹️", text: "abortada", tone: "aborted" }
  }
  return { status: "pending", glyph: "•", text: value || "—", tone: "pending" }
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Primer valor textual no vacío de entre las claves indicadas. */
function firstText(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return ""
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
