import { dirname, join } from "node:path"

import { buildTaskPrompt, extractReport } from "./contracts"
import { buildSessionPermissions } from "./permissions"
import { modelLabel, shortTitle, splitModelRef } from "./types"
import type {
  OrchestrateInput,
  PluginCtx,
  RunControl,
  TaskResult,
  TaskSpec,
} from "./types"

export interface RunnerOptions {
  ctx: PluginCtx
  input: OrchestrateInput
  baseBranch: string
  workdir: string
  /** ID canónico del run (lo elige el llamador y se usa en sesiones, worktrees y storage). */
  runId: string
  /** true = conservar sesiones hijas al terminar. */
  keepSessions: boolean
  /** ID de la sesión orquestadora; las hijas se crean como subagentes de ella. */
  parentSessionID?: string
  /** Se invoca al cerrar cada oleada con el avance acumulado (para persistir el estado). */
  onUpdate?: (snapshot: { results: readonly TaskResult[] }) => void | Promise<void>
  /** ID del proyecto (requerido para worktrees). */
  projectID?: string
  /** Directorio padre para los worktrees (default: <padre del repo>/worktrees). */
  worktreeParent?: string
  /** true = eliminar los worktrees de tareas exitosas al terminar el run. */
  cleanupWorktrees?: boolean
  /** Estado compartido para cancelar el run (aiapaec_run_abort). */
  control?: RunControl
  /** Timeout por tarea en ms (0/undefined = sin límite). */
  taskTimeoutMs?: number
  /** Se invoca al iniciar cada tarea (para mostrar tareas en curso y su actividad). */
  onTaskStart?: (info: {
    taskId: string
    agent: string
    branch: string
    /** Sesión hija ya creada (la usa el feed de actividad). */
    sessionID?: string
    /** Modelo esperado: override de la tarea o el del agente (`providerID/modelID`). */
    model?: string
    /** Título corto del nodo (declarado o derivado del objective). */
    title?: string
    /** ISO de creación de la sesión hija. */
    startedAt?: string
  }) => void | Promise<void>
}

export interface OrchestrationResult {
  runId: string
  startedAt: string
  finishedAt: string
  results: TaskResult[]
}

export function validateTasks(tasks: TaskSpec[]): string[] {
  const errors: string[] = []
  const ids = new Set<string>()

  for (const task of tasks) {
    if (!task.id?.trim()) {
      errors.push("Hay una tarea sin id.")
      continue
    }
    if (ids.has(task.id)) errors.push(`ID de tarea duplicado: ${task.id}`)
    ids.add(task.id)
    if (!task.agent?.trim()) errors.push(`La tarea ${task.id} no tiene agente.`)
    if (!task.objective?.trim()) errors.push(`La tarea ${task.id} no tiene objetivo.`)
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) {
        errors.push(`La tarea ${task.id} depende de una tarea inexistente: ${dep}`)
      }
    }
  }

  return errors
}

/**
 * Agrupa las tareas en oleadas: cada oleada contiene tareas cuyas
 * dependencias ya se completaron. Las tareas de una misma oleada se
 * ejecutan en paralelo.
 */
export function planWaves(tasks: TaskSpec[]): TaskSpec[][] {
  const waves: TaskSpec[][] = []
  const done = new Set<string>()
  let remaining = [...tasks]

  while (remaining.length > 0) {
    const wave = remaining.filter((task) =>
      (task.dependsOn ?? []).every((dep) => done.has(dep)),
    )

    if (wave.length === 0) {
      const pendientes = remaining.map((task) => task.id).join(", ")
      throw new Error(`Dependencias circulares detectadas entre: ${pendientes}`)
    }

    for (const task of wave) done.add(task.id)
    waves.push(wave)
    remaining = remaining.filter((task) => !wave.includes(task))
  }

  return waves
}

export async function runOrchestration(options: RunnerOptions): Promise<OrchestrationResult> {
  const { ctx, input, baseBranch, workdir, keepSessions } = options

  const errors = validateTasks(input.tasks)
  if (errors.length > 0) {
    throw new Error(errors.join("\n"))
  }

  const startedAt = new Date().toISOString()
  const runId = options.runId
  const results: TaskResult[] = []
  const byId = new Map<string, TaskResult>()
  const worktreeParent = options.worktreeParent ?? join(dirname(options.workdir), "worktrees")
  const createdWorktrees = new Map<string, string>()

  for (const wave of planWaves(input.tasks)) {
    const runnable: TaskSpec[] = []

    for (const task of wave) {
      const failedDependency = (task.dependsOn ?? []).find(
        (dep) => byId.get(dep)?.status !== "succeeded",
      )

      if (failedDependency) {
        const skipped: TaskResult = {
          taskId: task.id,
          agent: task.agent,
          status: "skipped",
          error: `Dependencia no completada: ${failedDependency}`,
        }
        results.push(skipped)
        byId.set(task.id, skipped)
        continue
      }

      runnable.push(task)
    }

    const settled = await Promise.allSettled(
      runnable.map((task) =>
        executeTask(ctx, task, {
          runId,
          runObjective: input.objective,
          baseBranch,
          workdir,
          keepSessions,
          parentSessionID: options.parentSessionID,
          projectID: options.projectID,
          worktreeParent,
          control: options.control,
          taskTimeoutMs: options.taskTimeoutMs,
          onTaskStart: options.onTaskStart,
          upstream: (task.dependsOn ?? [])
            .map((dep) => byId.get(dep))
            .filter((entry): entry is TaskResult => Boolean(entry))
            .map((entry) => ({
              taskId: entry.taskId,
              worktreeDirectory: entry.worktreeDirectory,
              branch: entry.branch,
            })),
        }),
      ),
    )

    settled.forEach((outcome, index) => {
      const task = runnable[index]!
      const result: TaskResult =
        outcome.status === "fulfilled"
          ? outcome.value
          : {
              taskId: task.id,
              agent: task.agent,
              status: "failed",
              error: String(outcome.reason ?? "Error desconocido"),
            }
      results.push(result)
      byId.set(result.taskId, result)
      if (result.worktreeDirectory) {
        createdWorktrees.set(result.taskId, result.worktreeDirectory)
      }
    })

    if (options.onUpdate) {
      try {
        await options.onUpdate({ results: [...results] })
      } catch {
        // El avance es informativo; no debe romper la orquestación.
      }
    }
  }

  if (options.cleanupWorktrees && options.projectID) {
    for (const [taskId, directory] of createdWorktrees) {
      const result = byId.get(taskId)
      if (!result || result.status !== "succeeded") continue
      try {
        await ctx.worktree.remove({
          projectID: options.projectID,
          directory,
          force: false,
        })
        const target = byId.get(taskId)
        if (target) target.worktreeRemoved = true
      } catch {
        // La limpieza es best-effort: el worktree queda para inspección.
      }
    }
  }

  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  }
}

interface TaskRunOptions {
  runId: string
  runObjective: string
  baseBranch: string
  workdir: string
  keepSessions: boolean
  parentSessionID?: string
  projectID?: string
  worktreeParent?: string
  upstream?: Array<{ taskId: string; worktreeDirectory?: string; branch?: string }>
  control?: RunControl
  taskTimeoutMs?: number
  onTaskStart?: (info: {
    taskId: string
    agent: string
    branch: string
    sessionID?: string
    model?: string
    title?: string
    startedAt?: string
  }) => void | Promise<void>
}

async function executeTask(
  ctx: PluginCtx,
  task: TaskSpec,
  options: TaskRunOptions,
): Promise<TaskResult> {
  const branch = task.branch ?? `feat/${task.id}`
  const title = task.title?.trim() || shortTitle(task.objective)
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  let sessionID: string | undefined
  let worktreeDirectory: string | undefined

  if (options.control?.aborted) {
    return {
      taskId: task.id,
      agent: task.agent,
      status: "skipped",
      branch,
      title,
      error: "Run abortado por el usuario",
    }
  }

  const sensitive = task.permissions ?? {}
  const needsGate =
    sensitive.push_to_remote === true ||
    sensitive.create_pull_request === true ||
    sensitive.production_deploy === true

  if (needsGate) {
    if (!options.parentSessionID) {
      return {
        taskId: task.id,
        agent: task.agent,
        status: "failed",
        branch,
        title,
        error: "La tarea pide permisos sensibles pero no hay sesión orquestadora para el gate.",
      }
    }
    try {
      await ctx.permission.assert({
        sessionID: options.parentSessionID,
        action: "deploy",
        resources: [task.id, branch],
        save: [task.id],
        metadata: { taskId: task.id, branch, permissions: sensitive },
      })
    } catch (error) {
      return {
        taskId: task.id,
        agent: task.agent,
        status: "failed",
        branch,
        error: `Permiso denegado para la tarea ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // Modelo esperado: el override de la tarea manda; si no, el que declara el
  // agente en opencode.json (`agent.get` es opcional y puede faltar).
  const expectedModel = modelLabel(task.model) ?? (await agentDefaultModel(ctx, task.agent))

  try {
    if (task.worktree) {
      if (!options.projectID) {
        throw new Error(`La tarea ${task.id} pidió worktree pero no hay projectID disponible.`)
      }
      if (!options.worktreeParent) {
        throw new Error(`La tarea ${task.id} pidió worktree pero falta el directorio padre.`)
      }
      const worktree = await ctx.worktree.create({
        projectID: options.projectID,
        branch: options.baseBranch,
        directory: normalizePath(options.worktreeParent),
        name: worktreeName(options.runId, task.id),
      })
      worktreeDirectory = worktree.directory
    }

    const created = await ctx.session.create({
      title: `[orq] ${task.id} · ${task.agent}`,
      agent: task.agent,
      ...(options.parentSessionID ? { parentID: options.parentSessionID } : {}),
      ...(worktreeDirectory ? { location: { directory: worktreeDirectory } } : {}),
      permissions: buildSessionPermissions(task, worktreeDirectory ?? options.workdir),
      metadata: {
        orquestacion: true,
        runId: options.runId,
        taskId: task.id,
        objective: options.runObjective,
        // Título corto: la cascada del feed lo usa como nombre del nodo.
        title,
      },
      ...(expectedModel ? { model: parseModelRef(expectedModel) } : {}),
    })

    sessionID = created.id
    options.control?.sessions.add(sessionID)

    try {
      await options.onTaskStart?.({
        taskId: task.id,
        agent: task.agent,
        branch,
        sessionID,
        startedAt,
        title,
        ...(expectedModel ? { model: expectedModel } : {}),
      })
    } catch {
      // El avance es informativo.
    }

    if (options.control?.aborted) {
      try {
        await ctx.session.interrupt({ sessionID, resume: false })
      } catch {
        // La sesión pudo terminar antes del interrupt.
      }
    }

    await ctx.session.prompt({
      sessionID,
      text: buildTaskPrompt({
        task,
        baseBranch: options.baseBranch,
        runObjective: options.runObjective,
        worktreeDirectory,
        upstream: options.upstream,
      }),
    })

    await waitForSession(ctx, sessionID, options.taskTimeoutMs)

    const messages = await ctx.session.context({ sessionID })
    const { text, message } = extractAssistant(messages)

    if (message?.error) {
      throw new Error(
        typeof message.error === "string"
          ? message.error
          : JSON.stringify(message.error),
      )
    }

    const report = extractReport(text)
    const summary = pickString(report, "summary") ?? firstLine(text) ?? "(sin respuesta)"
    const reportStatus = pickString(report, "status")?.toLowerCase()
    // Modelo REAL con el que respondió el assistant (puede diferir del esperado
    // si el runtime resolvió otro). El SDK lo declara obligatorio.
    const realModel = modelLabel(message?.model) ?? expectedModel

    const baseResult: Omit<TaskResult, "status"> = {
      taskId: task.id,
      agent: task.agent,
      sessionID,
      branch: pickString(report, "artifacts.git_branch") ?? branch,
      worktreeDirectory,
      title,
      ...(realModel ? { model: realModel } : {}),
      ...(needsGate ? { gated: true } : {}),
      report,
      latencyMs: Date.now() - started,
      tokens: message?.tokens,
      cost: message?.cost,
    }

    if (!report || !reportStatus) {
      return {
        ...baseResult,
        status: "unconfirmed",
        summary,
        error: "Sin reporte JSON válido con status; revisar la salida del subagente",
      }
    }

    const failedByReport =
      reportStatus !== "success" && reportStatus !== "succeeded" && reportStatus !== "ok"

    return {
      ...baseResult,
      status: failedByReport ? "failed" : "succeeded",
      summary,
      ...(failedByReport ? { error: summary } : {}),
    }
  } catch (error) {
    if (sessionID) {
      try {
        await ctx.session.interrupt({ sessionID, resume: false })
      } catch {
        // La sesión pudo terminar antes del interrupt.
      }
    }
    const aborted = options.control?.aborted === true
    return {
      taskId: task.id,
      agent: task.agent,
      status: aborted ? "skipped" : "failed",
      sessionID,
      branch,
      worktreeDirectory,
      title,
      ...(expectedModel ? { model: expectedModel } : {}),
      latencyMs: Date.now() - started,
      error: aborted
        ? "Run abortado por el usuario"
        : error instanceof Error
          ? error.message
          : String(error),
    }
  } finally {
    if (sessionID) {
      options.control?.sessions.delete(sessionID)
    }
    if (sessionID && !options.keepSessions) {
      try {
        await ctx.session.remove?.({ sessionID })
      } catch {
        // La sesión queda abierta; no es un fallo de la tarea.
      }
    }
  }
}

function parseModelRef(raw: string): { providerID: string; id: string; variant?: string } {
  const ref = splitModelRef(raw)
  if (!ref) {
    throw new Error(
      `Modelo inválido "${raw}". Usa el formato "providerID/modelID", por ejemplo "opencode-go/glm-5.3-flash".`,
    )
  }
  return ref
}

/**
 * Modelo por defecto del agente según `agent.get({ agentID })` (`AgentInfo.model`).
 * Es best-effort: un runtime sin `agent.get` o sin modelo devuelve `undefined`
 * y el dashboard muestra `default`.
 */
async function agentDefaultModel(ctx: PluginCtx, agentID: string): Promise<string | undefined> {
  const get = ctx.agent?.get
  if (typeof get !== "function") return undefined

  try {
    const output: any = await get.call(ctx.agent, { agentID })
    const info = output?.data ?? output
    return modelLabel(info?.model)
  } catch {
    return undefined
  }
}

interface AssistantMessage {
  message?: any
  text: string
}

function extractAssistant(messages: any[]): AssistantMessage {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== "assistant") continue

    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text)
      .join("\n")
      .trim()

    return { message, text }
  }

  return { text: "" }
}

function pickString(value: unknown, path: string): string | undefined {
  if (!value || typeof value !== "object") return undefined

  let current: any = value
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined
    current = current[key]
  }

  return typeof current === "string" && current.trim() ? current : undefined
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.split("\n").find((entry) => entry.trim())
  return line?.trim()
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/")
}

function worktreeName(runId: string, taskId: string): string {
  const raw = `${runId}-${taskId}`
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
}

async function waitForSession(ctx: PluginCtx, sessionID: string, timeoutMs?: number): Promise<void> {
  if (!timeoutMs || timeoutMs <= 0) {
    await ctx.session.wait({ sessionID })
    return
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ctx.session.wait({ sessionID }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timeout de tarea (${timeoutMs} ms)`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
