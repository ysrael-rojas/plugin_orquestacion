import { buildTaskPrompt, extractReport } from "./contracts"
import { buildSessionPermissions } from "./permissions"
import type {
  OrchestrateInput,
  PluginCtx,
  TaskResult,
  TaskSpec,
} from "./types"

export interface RunnerOptions {
  ctx: PluginCtx
  input: OrchestrateInput
  baseBranch: string
  workdir: string
  /** true = conservar sesiones hijas al terminar. */
  keepSessions: boolean
  /** ID de la sesión orquestadora; las hijas se crean como subagentes de ella. */
  parentSessionID?: string
  /** Se invoca al cerrar cada oleada con el avance acumulado (para persistir el estado). */
  onUpdate?: (snapshot: { results: readonly TaskResult[] }) => void | Promise<void>
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
  const runId = `run-${startedAt.replace(/[:.]/g, "-")}`
  const results: TaskResult[] = []
  const byId = new Map<string, TaskResult>()

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
    })

    if (options.onUpdate) {
      try {
        await options.onUpdate({ results: [...results] })
      } catch {
        // El avance es informativo; no debe romper la orquestación.
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
}

async function executeTask(
  ctx: PluginCtx,
  task: TaskSpec,
  options: TaskRunOptions,
): Promise<TaskResult> {
  const branch = task.branch ?? `feat/${task.id}`
  const started = Date.now()
  let sessionID: string | undefined

  try {
    const created = await ctx.session.create({
      title: `[orq] ${task.id} · ${task.agent}`,
      agent: task.agent,
      ...(options.parentSessionID ? { parentID: options.parentSessionID } : {}),
      permissions: buildSessionPermissions(task, options.workdir),
      metadata: {
        orquestacion: true,
        runId: options.runId,
        taskId: task.id,
      },
      ...(task.model ? { model: parseModelRef(task.model) } : {}),
    })

    sessionID = created.id

    await ctx.session.prompt({
      sessionID,
      text: buildTaskPrompt({
        task,
        baseBranch: options.baseBranch,
        runObjective: options.runObjective,
      }),
    })

    await ctx.session.wait({ sessionID })

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
    const summary =
      pickString(report, "summary") ?? firstLine(text) ?? "(sin respuesta)"
    const reportStatus = pickString(report, "status")?.toLowerCase()
    const failedByReport =
      reportStatus != null &&
      reportStatus !== "success" &&
      reportStatus !== "succeeded" &&
      reportStatus !== "ok"

    return {
      taskId: task.id,
      agent: task.agent,
      status: failedByReport ? "failed" : "succeeded",
      sessionID,
      branch: pickString(report, "artifacts.git_branch") ?? branch,
      summary,
      report,
      text,
      latencyMs: Date.now() - started,
      tokens: message?.tokens,
      cost: message?.cost,
      ...(failedByReport ? { error: summary } : {}),
    }
  } catch (error) {
    return {
      taskId: task.id,
      agent: task.agent,
      status: "failed",
      sessionID,
      branch,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (sessionID && !options.keepSessions) {
      try {
        await ctx.session.remove?.({ sessionID })
      } catch {
        // La sesión queda abierta; no es un fallo de la tarea.
      }
    }
  }
}

function parseModelRef(raw: string): { providerID: string; id: string } {
  const slash = raw.indexOf("/")
  if (slash <= 0) {
    throw new Error(
      `Modelo inválido "${raw}". Usa el formato "providerID/modelID", por ejemplo "opencode-go/glm-5.3-flash".`,
    )
  }
  return {
    providerID: raw.slice(0, slash),
    id: raw.slice(slash + 1),
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
