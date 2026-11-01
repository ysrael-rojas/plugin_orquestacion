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
  git_commit?: boolean
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
  /** Override de modelo, formato "providerID/modelID". */
  model?: string
  metadata?: Record<string, unknown>
}

export interface OrchestrateInput {
  objective: string
  tasks: TaskSpec[]
  /** Si es true, conserva las sesiones hijas para inspección. */
  keepSessions?: boolean
}

export type TaskStatus = "succeeded" | "failed" | "skipped"

export interface TaskResult {
  taskId: string
  agent: string
  status: TaskStatus
  sessionID?: string
  branch?: string
  summary?: string
  report?: unknown
  text?: string
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
  finishedAt: string
  results: TaskResult[]
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
  location: { directory: string }
  session: {
    create(input: any): Promise<{ id: string }>
    prompt(input: any): Promise<unknown>
    wait(input: any): Promise<void>
    context(input: any): Promise<any[]>
    update(input: any): Promise<void>
    remove?(input: any): Promise<void>
  }
  storage: {
    set(key: string, value: any): Promise<void>
    get(key: string): Promise<any>
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
