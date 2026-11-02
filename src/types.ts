/**
 * Tipos compartidos del plugin de orquestación.
 *
 * El plugin usa un tipo estructural mínimo del contexto para mantener el
 * código legible y no acoplarse a los tipos internos de Effect.
 */

export interface TaskScope {
  allowed_files?: string[]
  forbidden_files?: string[]
}

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
  metadata?: Record<string, unknown>
}

export interface OrchestrateInput {
  objective: string
  tasks: TaskSpec[]
  /** Si es true, conserva las sesiones hijas para inspección. */
  keepSessions?: boolean
  /** Contexto adicional de la orquestación (usado en el documento de plan). */
  context?: TaskContextInfo
}

export type TaskStatus = "succeeded" | "failed" | "skipped" | "unconfirmed"

export interface TaskResult {
  taskId: string
  agent: string
  status: TaskStatus
  sessionID?: string
  branch?: string
  worktreeDirectory?: string
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
  baseBranch: string
  startedAt: string
  finishedAt?: string
  status: "running" | "completed" | "failed" | "aborted"
  totalTasks: number
  /** Tareas actualmente en vuelo (solo mientras el run está running). */
  inFlight?: string[]
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
  branch?: string
  dependsOn?: string[]
}

export interface PlanDocsState {
  workdir: string
  folder: string
  runId: string
  objective: string
  baseBranch: string
  startedAt: string
  finishedAt?: string
  status: RunRecord["status"]
  contextSummary?: string
  tasks: PlanDocsTaskSpec[]
  results: TaskResult[]
  inFlight: string[]
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
