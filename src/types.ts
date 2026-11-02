/**
 * Tipos compartidos del plugin de orquestación.
 *
 * El plugin usa un tipo estructural mínimo del contexto para mantener el
 * código legible y no acoplarse a los tipos internos de Effect.
 *
 * Además de tipos, expone dos helpers puros que comparten varias capas
 * (`shortTitle` y `modelLabel`): así el árbol del dashboard, el runner y las
 * tools formatean títulos y modelos de la misma manera.
 */

export interface TaskScope {
  allowed_files?: string[]
  forbidden_files?: string[]
}

/**
 * Profundidad de validación de una tarea de QA.
 *
 * - `L1`: smoke (solo `pnpm test` con evidencia del comando).
 * - `L2`: estándar (validación contra el spec del contrato con evidencia).
 * - `L3`: forense (L2 + supuestos técnicos verificados contra fuentes reales).
 */
export type QaLevel = "L1" | "L2" | "L3"

export interface TaskContextInfo {
  summary?: string
  engram_ids?: string[]
}

export interface TaskPermissions {
  write_files?: boolean
  execute_bash?: boolean
  /** Si es false, se deniega `git commit` por bash. */
  git_commit?: boolean
  /** Acción sensible: pasa por el gate de permiso (permission.assert) antes de ejecutarse. */
  push_to_remote?: boolean
  /** Acción sensible: pasa por el gate de permiso. */
  create_pull_request?: boolean
  /** Acción sensible: pasa por el gate de permiso. */
  production_deploy?: boolean
}

export interface TaskSpec {
  /** ID único de la subtarea, por ejemplo "TASK-101-BE". */
  id: string
  /** Agente destino registrado en opencode.json. */
  agent: string
  /** Objetivo concreto de la subtarea. */
  objective: string
  /**
   * Título corto del nodo en el árbol del dashboard.
   * Fallback: primera línea del `objective` truncada a 60 caracteres (ver `shortTitle`).
   */
  title?: string
  /** IDs de subtareas que deben completarse antes. */
  dependsOn?: string[]
  /** Rama de trabajo; por defecto `feat/<id>`. */
  branch?: string
  scope?: TaskScope
  context?: TaskContextInfo
  permissions?: TaskPermissions
  /** Si es true y hay allowed_files, solo se permite editar esos archivos. */
  strict_scope?: boolean
  /** Ejecuta la tarea en un git worktree aislado (requiere projectID). */
  worktree?: boolean
  /** Override de modelo, formato "providerID/modelID". */
  model?: string
  /** Nivel de exigencia de la validación de QA (default `L2`). */
  qaLevel?: QaLevel
  /**
   * Skills que el orquestador declara para la tarea (p. ej. `["tdd"]`).
   * Se deduplican; una entrada inválida se descarta sin abortar el plan.
   */
  skills?: string[]
  metadata?: Record<string, unknown>
}

export interface OrchestrateInput {
  objective: string
  /** Título corto del run en el árbol del dashboard (fallback: `objective`). */
  title?: string
  tasks: TaskSpec[]
  /** Si es true, conserva las sesiones hijas para inspección. */
  keepSessions?: boolean
  /** Contexto adicional de la orquestación (usado en el documento de plan). */
  context?: TaskContextInfo
}

export type TaskStatus = "succeeded" | "failed" | "skipped" | "unconfirmed"

/**
 * Campos de una tarea en vuelo: el runner la registra al crear la sesión hija
 * y la tool la persiste en `RunRecord.inFlight` mientras el run está `running`.
 */
export interface InFlightTaskFields {
  taskId: string
  agent: string
  /** Modelo esperado (`providerID/modelID`); ausente si el agente no declara uno. */
  model?: string
  branch?: string
  /** ISO de creación de la sesión hija. */
  startedAt?: string
  /** Título corto del nodo (fallback: `taskId`). */
  title?: string
}

/**
 * Tarea en vuelo del contrato v4. **En runtime siempre es un objeto**
 * (`{ taskId, agent, model?, branch?, startedAt? }`), no un string.
 *
 * La intersección con `string` es un puente transitorio: el view-model v3
 * (`dashboard-view.ts`, que reescribe la tarea de UI) todavía lee
 * `RunRecord.inFlight` como si fueran IDs. Construye estos valores con
 * `toInFlightTask` y normalízalos al leer con `inFlightEntries`; nunca asignes
 * un string a este tipo.
 */
export type InFlightTask = string & InFlightTaskFields

/** Construye una tarea en vuelo del contrato v4 (ver nota del tipo). */
export function toInFlightTask(fields: InFlightTaskFields): InFlightTask {
  return fields as unknown as InFlightTask
}

/**
 * Normaliza `RunRecord.inFlight` sea cual sea su generación: objetos v4 u
 * `string[]` heredados del historial v3. Devuelve siempre objetos.
 */
export function inFlightEntries(raw: unknown): InFlightTask[] {
  if (!Array.isArray(raw)) return []

  const entries: InFlightTask[] = []
  for (const entry of raw) {
    if (typeof entry === "string") {
      const taskId = entry.trim()
      if (taskId) entries.push(toInFlightTask({ taskId, agent: "—" }))
      continue
    }
    if (!entry || typeof entry !== "object") continue

    const record = entry as Record<string, unknown>
    const taskId = text(record.taskId)
    if (!taskId) continue

    const model = text(record.model)
    const branch = text(record.branch)
    const startedAt = text(record.startedAt)
    const title = text(record.title)
    entries.push(
      toInFlightTask({
        taskId,
        agent: text(record.agent) ?? "—",
        ...(model ? { model } : {}),
        ...(branch ? { branch } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(title ? { title } : {}),
      }),
    )
  }
  return entries
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export interface TaskResult {
  taskId: string
  agent: string
  status: TaskStatus
  sessionID?: string
  branch?: string
  worktreeDirectory?: string
  /** Título corto del nodo en el árbol (declarado en el `TaskSpec` o derivado del objective). */
  title?: string
  /** Modelo REAL con el que respondió el assistant de la sesión hija (`providerID/modelID`). */
  model?: string
  /** Nivel de QA efectivo de la tarea (L1/L2/L3); el runner no lo resuelve, lo adjunta la tool. */
  qaLevel?: QaLevel
  /** Skills efectivas de la tarea (deduplicadas); las adjunta la tool al persistir el resultado. */
  skills?: string[]
  /** true si la tarea pasó por un gate de permiso aprobado. */
  gated?: boolean
  /** true si el worktree de la tarea se eliminó al finalizar (cleanup). */
  worktreeRemoved?: boolean
  summary?: string
  report?: unknown
  latencyMs?: number
  tokens?: unknown
  cost?: unknown
  error?: string
}

export interface RunRecord {
  runId: string
  objective: string
  /** Título corto del run en el árbol (fallback: `objective`). */
  title?: string
  baseBranch: string
  startedAt: string
  finishedAt?: string
  status: "running" | "completed" | "failed" | "aborted"
  totalTasks: number
  /**
   * Tareas actualmente en vuelo (solo mientras el run está running).
   * Desde el contrato v4 son objetos con agente y modelo, no solo IDs.
   */
  inFlight?: InFlightTask[]
  results: TaskResult[]
  error?: string
  /** Advertencias acumuladas de escrituras best-effort del documento de plan. */
  planDocWarnings?: string[]
}

/** Estado compartido para cancelar un run en curso. */
export interface RunControl {
  aborted: boolean
  sessions: Set<string>
  /** Estado del documento de plan, si está activo para este run. */
  planDocs?: PlanDocsState
  /** Advertencias acumuladas de escrituras best-effort del documento de plan. */
  planDocWarnings?: string[]
}

export interface PlanDocsTaskSpec {
  id: string
  agent: string
  objective: string
  /** Título corto de la tarea (fallback: primera línea del objective). */
  title?: string
  branch?: string
  dependsOn?: string[]
}

export interface PlanDocsState {
  workdir: string
  folder: string
  runId: string
  objective: string
  /** Título corto del run. */
  title?: string
  baseBranch: string
  startedAt: string
  finishedAt?: string
  status: RunRecord["status"]
  contextSummary?: string
  tasks: PlanDocsTaskSpec[]
  results: TaskResult[]
  inFlight: InFlightTask[]
}

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/**
 * Subconjunto estructural del contexto de plugin que usa este proyecto.
 * El contexto real de OpenCode cumple esta interfaz (tiene más campos).
 */
export interface PluginCtx {
  options: Record<string, any>
  location: { directory: string; project?: { id?: string } }
  permission: {
    assert(input: any): Promise<void>
  }
  worktree: {
    create(input: any): Promise<{ directory: string }>
    remove(input: any): Promise<void>
  }
  session: {
    create(input: any): Promise<{ id: string }>
    prompt(input: any): Promise<unknown>
    wait(input: any): Promise<void>
    context(input: any): Promise<any[]>
    interrupt(input: any): Promise<unknown>
    remove?(input: any): Promise<void>
  }
  storage: {
    set(key: string, value: any): Promise<void>
    get(key: string): Promise<any>
    remove(key: string): Promise<void>
    scan(options: {
      prefix: string
      limit?: number
      after?: string
    }): Promise<{ entries: Array<{ key: string; value: any }>; next?: string }>
  }
  mcp: {
    list(input?: any): Promise<any>
  }
  agent: {
    list(input?: any): Promise<any>
    /**
     * Info del agente (`AgentInfo`), incluido su `model?` por defecto.
     * El dominio real expone `agent.get({ agentID })`; es opcional para
     * contextos de prueba antiguos.
     */
    get?(input: any): Promise<any> | any
  }
  command: {
    transform(cb: (editor: any) => void): Promise<{ dispose?: () => Promise<void> }>
  }
  tool: {
    transform(cb: (editor: any) => void): Promise<{ dispose?: () => Promise<void> }>
  }
}

/** Opciones de configuración del plugin definidas en `opencode.json`. */
export interface PluginOptions {
  /** Rama base desde la que se derivan las ramas de tarea. */
  baseBranch?: string
  /** Si es `true`, elimina las sesiones hijas al terminar. */
  cleanupSessions?: boolean
  /** Si es `true`, elimina los worktrees de tareas exitosas al terminar. */
  cleanupWorktrees?: boolean
  /** Directorio padre donde se crean los worktrees. */
  worktreeParent?: string
  /** Timeout por tarea en milisegundos. */
  taskTimeoutMs?: number
  /** Cuántos runs conservar en el historial (entero positivo, default 50). */
  runHistory?: number
  /** Si es `false`, desactiva el documento de plan; si es string, carpeta relativa destino. */
  planDocs?: boolean | string
  /**
   * Puerto del dashboard web local (127.0.0.1). Default `4780`.
   * `0` desactiva el dashboard; un valor inválido cae a `4780` con warning.
   */
  dashboardPort?: number
}

/** Longitud máxima de un título corto derivado del objective. */
export const SHORT_TITLE_MAX = 60

/** Etiqueta de modelo cuando el agente no declara uno (`ctx.agent.get` sin `model`). */
export const DEFAULT_MODEL_LABEL = "default"

/**
 * Título corto para un nodo del árbol: primera línea, espacios colapsados y
 * truncado a `max` caracteres (con elipsis).
 *
 * Vive aquí porque lo comparten `tools`, `runner` y `dashboard`; es puro y no
 * depende de ningún dominio.
 */
export function shortTitle(value: string | undefined, max = SHORT_TITLE_MAX): string {
  // Primera línea con contenido: el fallback nunca arrastra el resto del prompt.
  const line = (value ?? "").split(/\r?\n/).find((entry) => entry.trim()) ?? ""
  const text = line.replace(/\s+/g, " ").trim()
  if (!text) return ""
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).replace(/\s+$/, "")}…`
}

/**
 * Etiqueta legible de un modelo (`providerID/modelID`, con `#variant` si la hay).
 *
 * Acepta tanto el string `providerID/modelID` que usa `TaskSpec.model` como el
 * objeto `{ providerID, id, variant? }` del SDK (`AgentInfo.model`,
 * `SessionMessageAssistant.model` y `session.created`). Devuelve `undefined`
 * si la referencia no es utilizable (el llamador decide el fallback).
 */
export function modelLabel(ref: unknown): string | undefined {
  if (typeof ref === "string") {
    const text = ref.trim()
    return text || undefined
  }
  if (!ref || typeof ref !== "object") return undefined

  const record = ref as Record<string, unknown>
  const provider = typeof record.providerID === "string" ? record.providerID.trim() : ""
  const id = typeof record.id === "string" ? record.id.trim() : ""
  if (!provider || !id) return undefined

  const variant = typeof record.variant === "string" && record.variant.trim()
    ? `#${record.variant.trim()}`
    : ""
  return `${provider}/${id}${variant}`
}
