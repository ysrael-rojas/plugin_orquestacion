/**
 * Feed de actividad en vivo de las sesiones de orquestación.
 *
 * Escucha el stream de eventos V2 (`ctx.event.subscribe()`) y, para las
 * sesiones que el runner registra explícitamente, guarda un ring buffer en RAM
 * con las últimas acciones reales (herramienta + argumento principal). Nunca
 * persiste nada ni guarda salidas completas: solo `{ tool, summary, at }`.
 *
 * Todo es best-effort: un evento que falla no corta el bucle y una sesión no
 * registrada se ignora. Si el stream no existe (tests, runtime sin eventos) el
 * feed queda vacío y el dashboard muestra "sin actividad registrada".
 */

/** Cuántas acciones se conservan por sesión (ring buffer). */
export const ACTIVITY_BUFFER_SIZE = 8
/** Longitud máxima del resumen de una acción. */
export const ACTIVITY_SUMMARY_MAX = 80

export interface ActivityItem {
  /** Nombre de la herramienta ejecutada ("read", "bash", "edit"...). */
  tool: string
  /** Primer argumento relevante (ruta, comando...) truncado a 80 caracteres. */
  summary: string
  /** Marca de tiempo del evento (epoch ms). */
  at: number
}

/** Metadatos con los que el runner etiqueta una sesión observada. */
export interface ActivityRegistration {
  /** Texto visible (taskId o "orquestador"). */
  label?: string
  /** Run al que pertenece la sesión (permite resolverla desde el dashboard). */
  runId?: string
  /** Tarea del run, si la sesión es una tarea hija. */
  taskId?: string
  /** Rol de la sesión dentro del run. */
  role?: "orchestrator" | "task"
}

/** Fuente de actividad que consume el view-model del dashboard. */
export interface DashboardActivitySource {
  task(runId: string, taskId: string): readonly ActivityItem[]
  orchestrator(runId: string): readonly ActivityItem[]
}

/**
 * Contexto mínimo que necesita el feed. El `PluginCtx` real cumple esta forma
 * (el dominio de eventos no forma parte del subconjunto estructural de tipos).
 */
export interface ActivityEventCtx {
  event?: { subscribe?(options?: unknown): AsyncIterable<unknown> }
}

interface SessionBuffer {
  label?: string
  runId?: string
  taskId?: string
  role?: "orchestrator" | "task"
  items: ActivityItem[]
  /** Nombre de herramienta por id de llamada (llega en `tool.input.started`). */
  pending: Map<string, string>
  /** Último resumen emitido por id de llamada/part, para no duplicar. */
  emitted: Map<string, string>
}

/** Claves donde los tools de OpenCode suelen poner el argumento principal. */
const SUMMARY_KEYS = [
  "filePath",
  "file_path",
  "path",
  "file",
  "filename",
  "command",
  "cmd",
  "pattern",
  "description",
  "query",
  "url",
  "prompt",
  "text",
  "goal",
]

/** Tope de ids auxiliares por sesión (evita crecer sin límite en runs largos). */
const PENDING_LIMIT = 32

export class ActivityFeed {
  private readonly sessions = new Map<string, SessionBuffer>()
  private subscribed = false
  private closed = false

  /**
   * Arranca la suscripción a eventos (idempotente). No bloquea: si el runtime
   * no expone `ctx.event` simplemente no hay feed.
   */
  ensureSubscribed(ctx: ActivityEventCtx | undefined): void {
    if (this.subscribed || this.closed) return
    void this.subscribe(ctx).catch(() => undefined)
  }

  /** Itera el stream de eventos hasta que se cierra o se llama a `cleanup`. */
  async subscribe(ctx: ActivityEventCtx | undefined): Promise<void> {
    if (this.subscribed || this.closed) return

    const event = ctx?.event
    const subscribe = event?.subscribe
    if (!event || typeof subscribe !== "function") return

    this.subscribed = true
    try {
      const stream = subscribe.call(event) as AsyncIterable<unknown>
      for await (const entry of stream) {
        if (this.closed) break
        try {
          this.ingest(entry)
        } catch {
          // Best-effort: un evento roto no debe cortar el bucle.
        }
      }
    } catch {
      // Stream caído (servicio reiniciado, etc.). Sin feed, pero sin romper nada.
    } finally {
      this.subscribed = false
    }
  }

  /** Empieza a observar una sesión. Re-registrarla conserva su buffer. */
  register(sessionID: string, label?: string, meta: ActivityRegistration = {}): void {
    const id = asText(sessionID)
    if (!id) return

    const role = meta.role ?? (meta.taskId ? "task" : undefined)
    const existing = this.sessions.get(id)
    if (existing) {
      if (label !== undefined) existing.label = label
      if (meta.runId !== undefined) existing.runId = meta.runId
      if (meta.taskId !== undefined) existing.taskId = meta.taskId
      if (role !== undefined) existing.role = role
      return
    }

    this.sessions.set(id, {
      label,
      runId: meta.runId,
      taskId: meta.taskId,
      role,
      items: [],
      pending: new Map(),
      emitted: new Map(),
    })
  }

  /** Deja de observar una sesión y descarta su buffer. */
  unregister(sessionID: string): void {
    const id = asText(sessionID)
    if (!id) return
    this.sessions.delete(id)
  }

  /** Descarta todas las sesiones de un run (fin o abort del run). */
  unregisterRun(runId: string): void {
    if (!runId) return
    for (const [sessionID, buffer] of [...this.sessions]) {
      if (buffer.runId === runId) this.sessions.delete(sessionID)
    }
  }

  /** Últimas acciones de una sesión (orden cronológico, máximo 8). */
  getActivity(sessionID: string): ActivityItem[] {
    const buffer = this.sessions.get(asText(sessionID))
    return buffer ? buffer.items.map(cloneItem) : []
  }

  /** Última acción registrada de una sesión, si la hay. */
  getLast(sessionID: string): ActivityItem | undefined {
    const buffer = this.sessions.get(asText(sessionID))
    return buffer && buffer.items.length > 0 ? cloneItem(buffer.items[buffer.items.length - 1]!) : undefined
  }

  /** Actividad de la tarea `taskId` dentro de `runId`. */
  activityForTask(runId: string, taskId: string): ActivityItem[] {
    if (!runId || !taskId) return []
    return this.collect(
      (buffer) =>
        buffer.runId === runId && buffer.taskId === taskId && buffer.role !== "orchestrator",
    )
  }

  /** Última acción conocida de una tarea, para la línea de `run_status`. */
  lastForTask(runId: string, taskId: string): ActivityItem | undefined {
    const items = this.activityForTask(runId, taskId)
    return items.length > 0 ? items[items.length - 1] : undefined
  }

  /** Actividad de la sesión orquestadora del run. */
  orchestratorActivity(runId: string): ActivityItem[] {
    if (!runId) return []
    return this.collect((buffer) => buffer.runId === runId && buffer.role === "orchestrator")
  }

  /** ¿Está registrada esta sesión? (expuesto para pruebas y diagnóstico). */
  isRegistered(sessionID: string): boolean {
    return this.sessions.has(asText(sessionID))
  }

  /** Corta la suscripción y vacía todos los buffers. */
  cleanup(): void {
    this.closed = true
    this.subscribed = false
    this.sessions.clear()
  }

  /** Como `cleanup`, pero deja el feed reutilizable (pruebas). */
  reset(): void {
    this.cleanup()
    this.closed = false
  }

  /**
   * Procesa un evento. Es público para que la suscripción y las pruebas usen
   * exactamente el mismo camino.
   */
  ingest(event: unknown): void {
    if (!event || typeof event !== "object") return
    const record = event as Record<string, any>
    const type = asText(record.type)
    if (!type) return

    // Variante V1 de "part de mensaje": trae el tool y su input juntos.
    if (type === "message.part.updated") {
      this.ingestPart(record)
      return
    }

    const data = (record.data ?? {}) as Record<string, any>
    const sessionID = asText(data.sessionID) ?? asText(record.sessionID)
    if (!sessionID) return
    const buffer = this.sessions.get(sessionID)
    if (!buffer) return

    if (type === "session.tool.input.started") {
      const callID = asText(data.id)
      const name = asText(data.name)
      if (!callID || !name) return
      buffer.pending.set(callID, name)
      trimMap(buffer.pending)
      return
    }

    if (type === "session.tool.called") {
      const callID = asText(data.id)
      const tool =
        (callID ? buffer.pending.get(callID) : undefined) ??
        asText(data.name) ??
        asText(data.tool) ??
        asText((data.state as Record<string, any> | undefined)?.tool) ??
        "tool"
      if (callID) buffer.pending.delete(callID)
      this.emit(buffer, callID, { tool, summary: summarizeToolInput(data.input), at: eventTime(record) })
    }
  }

  private ingestPart(record: Record<string, any>): void {
    const properties = (record.properties ?? {}) as Record<string, any>
    const part = properties.part ?? record.part
    if (!part || typeof part !== "object" || part.type !== "tool") return

    const sessionID =
      asText(part.sessionID) ?? asText(properties.sessionID) ?? asText(record.sessionID)
    if (!sessionID) return
    const buffer = this.sessions.get(sessionID)
    if (!buffer) return

    const input = part.state?.input ?? part.input
    const tool = asText(part.tool) ?? asText(part.name) ?? "tool"
    const callID = asText(part.id) ?? asText(part.callID)
    this.emit(buffer, callID, {
      tool,
      summary: summarizeToolInput(input),
      at: eventTime(record),
    })
  }

  private emit(buffer: SessionBuffer, callID: string | undefined, item: ActivityItem): void {
    // El streaming de parts repite el mismo part: no dupliques la misma acción.
    if (callID) {
      if (buffer.emitted.get(callID) === item.summary) return
      buffer.emitted.set(callID, item.summary)
      trimMap(buffer.emitted)
    }

    buffer.items.push(item)
    if (buffer.items.length > ACTIVITY_BUFFER_SIZE) {
      buffer.items.splice(0, buffer.items.length - ACTIVITY_BUFFER_SIZE)
    }
  }

  private collect(predicate: (buffer: SessionBuffer) => boolean): ActivityItem[] {
    const merged: ActivityItem[] = []
    for (const buffer of this.sessions.values()) {
      if (predicate(buffer)) merged.push(...buffer.items)
    }
    if (merged.length === 0) return []
    merged.sort((left, right) => left.at - right.at)
    return merged.slice(-ACTIVITY_BUFFER_SIZE).map(cloneItem)
  }
}

let singleton: ActivityFeed | undefined

/** Feed compartido del proceso (lo usan el runner, las tools y el dashboard). */
export function getActivityFeed(): ActivityFeed {
  if (!singleton) singleton = new ActivityFeed()
  return singleton
}

/**
 * Extrae el primer argumento relevante de la entrada de un tool y lo trunca a
 * 80 caracteres. Nunca incluye la salida del tool.
 */
export function summarizeToolInput(input: unknown, max: number = ACTIVITY_SUMMARY_MAX): string {
  return truncateSummary(firstArgument(input), max)
}

/** Recorta un texto a `max` caracteres (con elipsis) y colapsa espacios. */
export function truncateSummary(value: unknown, max: number = ACTIVITY_SUMMARY_MAX): string {
  const text = asText(value).replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).replace(/\s+$/, "")}…`
}

/** Formatea una marca de tiempo como tiempo relativo ("hace 5s", "hace 2m"). */
export function formatTimeAgo(at: number, now: Date = new Date()): string {
  if (!Number.isFinite(at)) return "—"
  const delta = now.getTime() - at
  if (!Number.isFinite(delta)) return "—"
  const seconds = Math.max(0, Math.floor(delta / 1000))
  if (seconds < 60) return `hace ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `hace ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours}h`
  return `hace ${Math.floor(hours / 24)}d`
}

function firstArgument(input: unknown): string {
  if (typeof input === "string") return input
  if (Array.isArray(input)) {
    return input.map((entry) => asText(entry)).filter(Boolean).join(" ")
  }
  if (!input || typeof input !== "object") return ""

  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    // Un getter roto debe propagar: el bucle de suscripción lo captura.
    const value = record[key]
    const text = asText(value)
    if (text) return text
  }
  for (const value of Object.values(record)) {
    const text = asText(value)
    if (text) return text
  }
  return ""
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map((entry) => asText(entry)).filter(Boolean).join(" ")
  return ""
}

function eventTime(record: Record<string, any>): number {
  const created = record.created
  if (typeof created === "number" && Number.isFinite(created) && created > 0) {
    // Algunos emisores usan segundos; normaliza a milisegundos.
    return created < 1e11 ? Math.round(created * 1000) : Math.round(created)
  }
  return Date.now()
}

function trimMap(map: Map<string, string>): void {
  while (map.size > PENDING_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

function cloneItem(item: ActivityItem): ActivityItem {
  return { tool: item.tool, summary: item.summary, at: item.at }
}
