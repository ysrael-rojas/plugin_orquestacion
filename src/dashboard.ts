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
 * - `/api/state` (contrato v2) añade la actividad en vivo por tarea en vuelo y
 *   la del orquestador, leída del feed en RAM (`src/activity.ts`).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { getActivityFeed } from "./activity"
import { renderDashboardHtml } from "./dashboard-html"
import {
  buildDashboardView,
  DASHBOARD_STATE_VERSION,
  type DashboardState,
} from "./dashboard-view"
import { recentRuns } from "./history"
import type { PluginCtx } from "./types"

/** Host del dashboard: siempre loopback. */
export const DASHBOARD_HOST = "127.0.0.1"
/** Puerto por defecto cuando la opción falta o es inválida. */
export const DEFAULT_DASHBOARD_PORT = 4780
/** Nombre de servicio que se anuncia en /api/health (para detectar instancias). */
export const DASHBOARD_SERVICE = "aiapaec-dashboard"

export { DASHBOARD_STATE_VERSION }
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
        sendHtml(response, renderDashboardHtml(state, { url: `http://${DASHBOARD_HOST}:${bound.port}` }))
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
async function readState(ctx: PluginCtx): Promise<DashboardState> {
  try {
    const runs = await recentRuns(ctx, 20)
    return buildDashboardView(runs, new Date(), activitySource())
  } catch (error) {
    console.warn(`[plugin-orquestacion] dashboard: no se pudo leer el estado (${describeError(error)}).`)
    return buildDashboardView([], new Date(), activitySource())
  }
}

/**
 * Fuente de actividad para el view-model: el feed en RAM del proceso. Si no
 * hay datos (sin eventos, sin sesiones registradas) devuelve listas vacías.
 */
function activitySource() {
  const feed = getActivityFeed()
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
