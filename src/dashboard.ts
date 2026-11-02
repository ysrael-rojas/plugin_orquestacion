/**
 * Servidor HTTP local del dashboard de orquestaciones.
 *
 * - Escucha SOLO en 127.0.0.1 (nunca en 0.0.0.0).
 * - Puerto configurable con la opción `dashboardPort` (default 4780, 0 = off).
 * - Singleton por proceso: si ya hay un dashboard vivo en esta instancia, se
 *   reutiliza.
 * - En `EADDRINUSE` consulta `GET /api/health` del ocupante: si es otra
 *   instancia viva se cede (con aviso); si es un proceso huérfano se reintenta
 *   una vez.
 * - Todo el arranque es best-effort: el dashboard jamás rompe una orquestación.
 * - `/api/state` sirve el contrato **v4** (árbol de ejecución): además del
 *   view-model v3 (progreso, estado, actividad), cada nodo lleva `title`,
 *   `model`, `inFlight` como objetos y `subsessions` anidadas por sesión.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import {
  formatTimeAgo,
  getActivityFeed,
  type ActivityFeed,
  type ActivityItem,
  type DashboardActivitySource,
  type SessionSummary,
} from "./activity"
import { renderDashboardHtml } from "./dashboard-html"
import {
  DASHBOARD_STATE_VERSION,
  buildDashboardView,
  sessionStatusMeta,
  type DashboardActivityRow,
  type DashboardOrchestratorView,
  type DashboardRunView,
  type DashboardSessionNode,
  type DashboardState,
  type DashboardTaskRow,
} from "./dashboard-view"
import { recentRuns } from "./history"
import { DEFAULT_MODEL_LABEL, inFlightEntries, shortTitle } from "./types"
import type { InFlightTask, PluginCtx, RunRecord } from "./types"

/** Host del dashboard: siempre loopback. */
export const DASHBOARD_HOST = "127.0.0.1"
/** Puerto por defecto cuando la opción falta o es inválida. */
export const DEFAULT_DASHBOARD_PORT = 4780
/** Nombre de servicio que se anuncia en /api/health (para detectar instancias). */
export const DASHBOARD_SERVICE = "aiapaec-dashboard"

/**
 * Versión del contrato de `/api/state`.
 *
 * v4 (árbol de ejecución): `title` por run y por tarea, `model` por nodo,
 * `inFlight` como objetos y `subsessions` anidadas por sesión. La constante
 * vive en el view-model (`dashboard-view.ts`) para que la vista y el servidor
 * no puedan desincronizarse; aquí solo se reexporta.
 */
export { DASHBOARD_STATE_VERSION }

/** Profundidad máxima del árbol de sub-sesiones (evita ciclos en eventos raros). */
export const MAX_SESSION_DEPTH = 6

/** Tarea en vuelo tal como la publica `/api/state` v4. */
export interface DashboardInFlightNode {
  taskId: string
  agent: string
  model: string
  branch?: string
  startedAt?: string
  title?: string
}

/** Nodo de tarea: la fila v3 más los campos del árbol. */
export interface DashboardTaskNode extends DashboardTaskRow {
  title: string
  model: string
  subsessions: DashboardSessionNode[]
}

/** Nodo raíz del run: la vista v3 más los campos del árbol. */
export interface DashboardOrchestratorNode extends DashboardOrchestratorView {
  sessionID?: string
  agent?: string
  model?: string
  title?: string
  subsessions: DashboardSessionNode[]
}

export interface DashboardRunNode
  extends Omit<DashboardRunView, "inFlight" | "tasks" | "orchestrator"> {
  title: string
  inFlight: DashboardInFlightNode[]
  tasks: DashboardTaskNode[]
  orchestrator?: DashboardOrchestratorNode
}

export interface DashboardStateV4
  extends Omit<DashboardState, "version" | "active" | "history"> {
  version: number
  active: DashboardRunNode | null
  history: DashboardRunNode[]
}

export type { DashboardState }

export interface DashboardHandle {
  host: string
  port: number
  url: string
  startedAt: string
  close(): Promise<void>
}

export interface NormalizedDashboardPort {
  port: number
  /** Presente si el valor recibido era inválido y se usó el default. */
  warning?: string
}

/**
 * Normaliza la opción `dashboardPort`:
 * - entero 1-65535 → se usa tal cual
 * - 0 → dashboard desactivado
 * - ausente → 4780
 * - cualquier otra cosa → 4780 + warning
 */
export function normalizeDashboardPort(raw: unknown): NormalizedDashboardPort {
  if (raw === undefined || raw === null) return { port: DEFAULT_DASHBOARD_PORT }

  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 65535) {
    return { port: raw }
  }

  return {
    port: DEFAULT_DASHBOARD_PORT,
    warning:
      `[plugin-orquestacion] dashboardPort inválido (${describe(raw)}): se usa ${DEFAULT_DASHBOARD_PORT}. ` +
      "Usa un entero entre 1 y 65535, o 0 para desactivar el dashboard.",
  }
}

let current: DashboardHandle | undefined

/** Handle del dashboard activo en este proceso, si lo hay. */
export function activeDashboard(): DashboardHandle | undefined {
  return current
}

/**
 * Arranca el dashboard (o devuelve el singleton activo).
 *
 * Con `port === 0` escucha en un puerto efímero (útil en pruebas). Devuelve
 * `undefined` si no se pudo arrancar; nunca lanza.
 */
export async function startDashboard(ctx: PluginCtx, port: number): Promise<DashboardHandle | undefined> {
  if (current) return current

  const requested = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_DASHBOARD_PORT
  // El handler necesita el puerto real (puede ser efímero cuando se pide 0).
  const bound = { port: requested }
  let server: Server | undefined
  let boundPort = requested

  try {
    server = await attemptListen(ctx, bound)
    boundPort = readPort(server, requested)
    bound.port = boundPort
  } catch (error) {
    if (!isAddrInUse(error)) {
      console.warn(`[plugin-orquestacion] dashboard: no se pudo escuchar en ${DASHBOARD_HOST}:${requested} (${describeError(error)}).`)
      closeQuietly(server)
      return undefined
    }

    if (await probeHealth(requested)) {
      console.warn(
        `[plugin-orquestacion] dashboard: el puerto ${requested} ya está servido por otra instancia viva; se cede (esta instancia no arranca otro).`,
      )
      closeQuietly(server)
      return undefined
    }

    console.warn(
      `[plugin-orquestacion] dashboard: puerto ${requested} ocupado por un proceso ajeno (posible huérfano); reintentando una vez.`,
    )
    try {
      server = await attemptListen(ctx, bound)
      boundPort = readPort(server, requested)
      bound.port = boundPort
    } catch (retryError) {
      console.warn(
        `[plugin-orquestacion] dashboard: el reintento en ${DASHBOARD_HOST}:${requested} falló (${describeError(retryError)}); el dashboard queda desactivado.`,
      )
      closeQuietly(server)
      return undefined
    }
  }

  const listening = server
  const url = `http://${DASHBOARD_HOST}:${boundPort}`
  let closed = false

  const handle: DashboardHandle = {
    host: DASHBOARD_HOST,
    port: boundPort,
    url,
    startedAt: new Date().toISOString(),
    async close() {
      if (closed) return
      closed = true
      if (current === handle) current = undefined
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        try {
          listening.close(done)
          listening.closeAllConnections?.()
        } catch {
          done()
        }
        const timer = setTimeout(done, 1500)
        timer.unref?.()
      })
    },
  }

  current = handle
  console.info(`[plugin-orquestacion] dashboard disponible en ${url}`)
  return handle
}

/** Cierra el dashboard activo (idempotente). */
export async function stopDashboard(): Promise<void> {
  const handle = current
  if (!handle) return
  await handle.close()
}

async function attemptListen(ctx: PluginCtx, bound: { port: number }): Promise<Server> {
  const server = createServer((request, response) => {
    void handleRequest(ctx, bound, request, response)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen({ host: DASHBOARD_HOST, port: bound.port })
  })

  return server
}

function readPort(server: Server, fallback: number): number {
  const address = server.address()
  return address && typeof address === "object" ? address.port : fallback
}

async function handleRequest(
  ctx: PluginCtx,
  bound: { port: number },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" })
      return
    }

    const url = new URL(request.url ?? "/", `http://${DASHBOARD_HOST}:${bound.port}`)

    switch (url.pathname) {
      case "/":
      case "/index.html": {
        const state = await readState(ctx)
        // El HTML de esta rama todavía pinta el view-model v3; los campos v4
        // (title/model/subsessions) son aditivos y el cliente los ignora hasta
        // que la tarea de UI los consuma.
        sendHtml(response, renderDashboardHtml(state as unknown as DashboardState, { url: `http://${DASHBOARD_HOST}:${bound.port}` }))
        return
      }
      case "/api/health": {
        const state = await readState(ctx)
        sendJson(response, 200, {
          ok: true,
          service: DASHBOARD_SERVICE,
          version: DASHBOARD_STATE_VERSION,
          uptimeMs: Math.round(process.uptime() * 1000),
          ...(state.active ? { runId: state.active.runId } : {}),
        })
        return
      }
      case "/api/state": {
        const state = await readState(ctx)
        sendJson(response, 200, state)
        return
      }
      case "/favicon.ico":
        response.writeHead(204, { "cache-control": "no-store" })
        response.end()
        return
      default:
        sendJson(response, 404, { ok: false, error: "not_found" })
    }
  } catch (error) {
    try {
      sendJson(response, 500, { ok: false, error: describeError(error) })
    } catch {
      // La respuesta ya no es escribible; nada que hacer.
    }
  }
}

/** Lee los runs del storage; si falla, devuelve un estado vacío válido. */
async function readState(ctx: PluginCtx): Promise<DashboardStateV4> {
  const feed = getActivityFeed()
  try {
    const runs = await recentRuns(ctx, 20)
    return buildTreeState(runs, new Date(), feed)
  } catch (error) {
    console.warn(`[plugin-orquestacion] dashboard: no se pudo leer el estado (${describeError(error)}).`)
    return buildTreeState([], new Date(), feed)
  }
}

/**
 * Construye el estado v4 (árbol de ejecución) sobre el view-model v3.
 *
 * Reutiliza `buildDashboardView` para todo lo que ya estaba resuelto (progreso,
 * glifos, duración, tokens) y decora cada nodo con `title`, `model`, `inFlight`
 * como objetos y `subsessions` del feed en RAM. Es puro salvo por el feed: sirve
 * para `/api/state` y para las pruebas.
 */
export function buildTreeState(
  runs: readonly RunRecord[],
  now: Date = new Date(),
  feed: ActivityFeed = getActivityFeed(),
): DashboardStateV4 {
  // El view-model v3 lee `inFlight` como IDs: le pasamos los runs sin tareas en
  // vuelo y las añadimos aquí como nodos v4 (con agente, modelo y startedAt).
  const sanitized = runs.map((run) => ({ ...run, inFlight: [] as InFlightTask[] }))
  const base = buildDashboardView(sanitized, now, activitySource(feed))
  const records = new Map(runs.map((run) => [run.runId, run]))
  const decorate = (view: DashboardRunView): DashboardRunNode => {
    const record = records.get(view.runId)
    if (record) return decorateRun(view, record, now, feed)

    const { inFlight: _inFlight, tasks: _tasks, orchestrator: _orchestrator, ...rest } = view
    return {
      ...rest,
      title: shortTitle(view.objective),
      inFlight: [],
      tasks: view.tasks.map(closedOnlyTask),
    }
  }

  return {
    ...base,
    version: DASHBOARD_STATE_VERSION,
    active: base.active ? decorate(base.active) : null,
    history: base.history.map(decorate),
  }
}

function closedOnlyTask(row: DashboardTaskRow): DashboardTaskNode {
  return { ...row, title: row.taskId, model: DEFAULT_MODEL_LABEL, subsessions: [] }
}

function decorateRun(
  view: DashboardRunView,
  record: RunRecord,
  now: Date,
  feed: ActivityFeed,
): DashboardRunNode {
  const inFlight = inFlightEntries(record.inFlight)
  const closed = new Set(record.results.map((entry) => entry.taskId))
  const pending = inFlight.filter((entry) => !closed.has(entry.taskId))
  const sessions = safeSessions(feed, record.runId)
  const orchestratorSession = sessions.find((session) => session.role === "orchestrator")

  const tasks: DashboardTaskNode[] = view.tasks.map((row) =>
    decorateTask(row, record, pending, sessions, now),
  )

  // Una tarea en vuelo sin fila (run huérfano sin snapshot en vuelo) se añade.
  const seen = new Set(tasks.map((task) => task.taskId))
  for (const entry of pending) {
    if (seen.has(entry.taskId)) continue
    tasks.push(pendingTask(entry, record, sessions, now, feed))
  }

  const orchestrator: DashboardOrchestratorNode | undefined = view.orchestrator
    ? {
        ...view.orchestrator,
        ...(orchestratorSession
          ? {
              sessionID: orchestratorSession.id,
              agent: orchestratorSession.agent,
              model: orchestratorSession.model ?? DEFAULT_MODEL_LABEL,
              title: orchestratorSession.title,
            }
          : {}),
        subsessions: feedSubsessions(orchestratorSession, sessions, now, view.orchestrator.subsessions),
      }
    : undefined

  const { inFlight: _inFlight, tasks: _tasks, orchestrator: _orchestrator, ...rest } = view
  return {
    ...rest,
    title: record.title || shortTitle(record.objective) || record.runId,
    inFlight: pending.map(toInFlightNode),
    tasks,
    ...(orchestrator ? { orchestrator } : {}),
  }
}

function decorateTask(
  row: DashboardTaskRow,
  record: RunRecord,
  pending: readonly InFlightTask[],
  sessions: readonly SessionSummary[],
  now: Date,
): DashboardTaskNode {
  const result = record.results.find((entry) => entry.taskId === row.taskId)
  const taskSession = sessions.find(
    (session) => session.role === "task" && session.taskId === row.taskId,
  )
  const inFlightEntry = pending.find((entry) => entry.taskId === row.taskId)

  return {
    ...row,
    ...(inFlightEntry
      ? {
          agent: inFlightEntry.agent || row.agent,
          branch: row.isRunning ? inFlightEntry.branch ?? row.branch : row.branch,
        }
      : {}),
    title: inFlightEntry?.title || result?.title || row.taskId,
    model: inFlightEntry?.model ?? result?.model ?? DEFAULT_MODEL_LABEL,
    subsessions: feedSubsessions(taskSession, sessions, now, row.subsessions),
  }
}

function pendingTask(
  entry: InFlightTask,
  record: RunRecord,
  sessions: readonly SessionSummary[],
  now: Date,
  feed: ActivityFeed,
): DashboardTaskNode {
  const running = record.status === "running"
  const taskSession = sessions.find(
    (session) => session.role === "task" && session.taskId === entry.taskId,
  )
  return {
    taskId: entry.taskId,
    title: entry.title || entry.taskId,
    agent: entry.agent || "—",
    model: entry.model ?? DEFAULT_MODEL_LABEL,
    status: running ? "running" : "skipped",
    glyph: running ? "⏳" : "⏭️",
    statusText: running ? "en curso" : "sin cerrar",
    tone: running ? "run" : "skipped",
    isRunning: running,
    branch: entry.branch ?? "—",
    time: "—",
    summary: "",
    ...(running
      ? { activity: toActivityRows(safeActivity(() => feed.activityForTask(record.runId, entry.taskId)), now) }
      : {}),
    subsessions: feedSubsessions(taskSession, sessions, now),
  }
}

function toInFlightNode(entry: InFlightTask): DashboardInFlightNode {
  return {
    taskId: entry.taskId,
    agent: entry.agent || "—",
    model: entry.model ?? DEFAULT_MODEL_LABEL,
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(entry.title ? { title: entry.title } : {}),
  }
}

/**
 * Sub-sesiones publicadas por `/api/state`: manda el feed en RAM (es la fuente
 * viva, con actividad) y, si no conoce la sesión, se conserva el árbol que ya
 * armó la vista desde `record.sessions`.
 */
function feedSubsessions(
  parent: SessionSummary | undefined,
  sessions: readonly SessionSummary[],
  now: Date,
  fallback?: readonly DashboardSessionNode[],
): DashboardSessionNode[] {
  const fromFeed = parent ? sessionNodes(parent, sessions, now) : []
  if (fromFeed.length > 0) return fromFeed
  return fallback ? [...fallback] : []
}

/** Sub-sesiones de una sesión, anidadas (los eventos raros no pueden ciclar). */
function sessionNodes(
  parent: SessionSummary,
  sessions: readonly SessionSummary[],
  now: Date,
  depth = 0,
): DashboardSessionNode[] {
  if (depth >= MAX_SESSION_DEPTH) return []

  return sessions
    .filter((session) => session.parentID === parent.id)
    .map((session) => {
      // El feed en RAM no reporta estado de sesión: el nodo queda "pendiente"
      // (glifo neutro, sin spinner falso) hasta que el runtime lo publique.
      const meta = sessionStatusMeta("")
      const children = sessionNodes(session, sessions, now, depth + 1)
      return {
        id: session.id,
        title: session.title || session.label || session.taskId || session.id,
        agent: session.agent ?? "—",
        model: session.model ?? DEFAULT_MODEL_LABEL,
        role: session.role ?? "sub",
        ...(session.taskId ? { taskId: session.taskId } : {}),
        status: meta.status,
        glyph: meta.glyph,
        statusText: meta.text,
        tone: meta.tone,
        activity: toActivityRows(session.activity, now),
        children,
        // El contrato v4 publica la cascada como `subsessions`; el HTML la pinta
        // como `children`. Es la misma lista: un solo árbol, dos nombres.
        subsessions: children,
      }
    })
}

function safeSessions(feed: ActivityFeed, runId: string): readonly SessionSummary[] {
  try {
    const sessions = feed.sessionsForRun(runId)
    return Array.isArray(sessions) ? sessions : []
  } catch {
    return []
  }
}

/** Convierte items crudos del feed en filas listas para pintar. */
function toActivityRows(items: readonly ActivityItem[], now: Date): DashboardActivityRow[] {
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

/**
 * Fuente de actividad para el view-model: el feed en RAM del proceso. Si no
 * hay datos (sin eventos, sin sesiones registradas) devuelve listas vacías.
 */
function activitySource(feed: ActivityFeed = getActivityFeed()): DashboardActivitySource {
  return {
    task: (runId: string, taskId: string) => feed.activityForTask(runId, taskId),
    orchestrator: (runId: string) => feed.orchestratorActivity(runId),
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(payload)
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  })
  response.end(html)
}

/** ¿Hay una instancia viva (de este plugin) escuchando en ese puerto? */
async function probeHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${DASHBOARD_HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    })
    if (!response.ok) return false
    const body: any = await response.json()
    return body?.ok === true && body?.service === DASHBOARD_SERVICE
  } catch {
    return false
  }
}

function isAddrInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "EADDRINUSE")
}

function closeQuietly(server: Server | undefined): void {
  if (!server) return
  try {
    server.close()
    server.closeAllConnections?.()
  } catch {
    // best-effort
  }
}

function describe(raw: unknown): string {
  if (typeof raw === "string") return JSON.stringify(raw)
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw)
  return typeof raw
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
