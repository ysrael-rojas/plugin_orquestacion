import { AGENTS } from "./agents"
import { formatTimeAgo, getActivityFeed, type ActivityEventCtx } from "./activity"
import { DEFAULT_QA_LEVEL, isQaLevel, normalizeQaLevels, normalizeSkills, resolveQaLevel } from "./contracts"
import { detectEngram, formatEngramStatus } from "./engram"
import { getRun, pruneRuns, recentRuns, saveRun } from "./history"
import { planDocsRelativePath, statusIcon, writePlanDocs } from "./plandocs"
import { runOrchestration, validateTasks } from "./runner"
import { DEFAULT_MODEL_LABEL, inFlightEntries, shortTitle, toInFlightTask } from "./types"
import type {
  InFlightTask,
  OrchestrateInput,
  PlanDocsState,
  PluginCtx,
  RunControl,
  RunRecord,
  TaskResult,
  TaskSpec,
} from "./types"

/** Runs activos en esta instancia del plugin (para aiapaec_run_abort). */
const activeRuns = new Map<string, RunControl>()

export interface ToolSettings {
  baseBranch: string
  cleanupSessions: boolean
  cleanupWorktrees: boolean
  worktreeParent?: string
  taskTimeoutMs?: number
  runHistory: number
  /** Carpeta relativa destino del plan; `false` desactiva el documento. */
  planDocs: string | false
  workdir: string
  /** Dashboard local activo en esta instancia (si se pudo arrancar). */
  dashboard?: { port: number; url: string }
}

export function registerTools(ctx: PluginCtx, settings: ToolSettings) {
  // Feed de actividad: suscripción best-effort a los eventos V2. Si el runtime
  // no expone `ctx.event`, el feed queda vacío y nada se rompe.
  getActivityFeed().ensureSubscribed(ctx as unknown as ActivityEventCtx)

  return ctx.tool.transform((editor: any) => {
    editor.namespace({
      name: "aiapaec",
      description:
        "Orquestación de agentes y subagentes (Aiapaec): delega tareas, ejecuta en paralelo y consolida reportes.",
    })
    editor.namespace({
      name: "gentle",
      description: "Estado y diagnóstico de la integración Engram.",
    })

    editor.add({
      name: "orchestrate",
      description:
        "Ejecuta un plan de subtareas delegadas a subagentes especializados (contexto, explorador, coder, qa, deployer). " +
        "Corre en segundo plano: devuelve un runId de inmediato y el avance se consulta con aiapaec_run_status, " +
        "así el trabajo no se pierde si la llamada se interrumpe. Las tareas sin dependencias corren en paralelo; " +
        "las que declaran dependsOn esperan. La rama base por defecto es 'dev'.",
      input: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description: "Objetivo global de la orquestación.",
          },
          title: {
            type: "string",
            description:
              "Título corto del run para el árbol del dashboard (por defecto, la primera línea del objective).",
          },
          tasks: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "ID único de la subtarea (ej. TASK-101-BE)." },
                agent: {
                  type: "string",
                  description: "Agente destino: contexto | explorador | coder | qa | deployer.",
                },
                objective: { type: "string", description: "Objetivo concreto de la subtarea." },
                title: {
                  type: "string",
                  description:
                    "Título corto del nodo en el árbol (por defecto, la primera línea del objective).",
                },
                dependsOn: {
                  type: "array",
                  items: { type: "string" },
                  description: "IDs de subtareas que deben completarse antes.",
                },
                branch: {
                  type: "string",
                  description: "Rama de trabajo. Por defecto feat/<id>.",
                },
                qaLevel: {
                  type: "string",
                  enum: ["L1", "L2", "L3"],
                  description:
                    "Nivel de exigencia de la validación (por defecto L2). " +
                    "L1 = smoke (solo pnpm test con evidencia del comando); " +
                    "L2 = estándar (validación contra el spec del contrato con evidencia); " +
                    "L3 = forense (L2 + supuestos técnicos verificados contra fuentes reales, p. ej. los .d.ts del SDK). " +
                    "Un valor inválido cae a L2 con aviso.",
                },
                skills: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Skills que el orquestador declara para la tarea (ej. tdd, code-review). " +
                    "Se deduplican; un valor inválido se descarta sin abortar el plan.",
                },
                scope: {
                  type: "object",
                  properties: {
                    allowed_files: { type: "array", items: { type: "string" } },
                    forbidden_files: { type: "array", items: { type: "string" } },
                  },
                  additionalProperties: false,
                },
                context: {
                  type: "object",
                  properties: {
                    summary: { type: "string" },
                    engram_ids: { type: "array", items: { type: "string" } },
                  },
                  additionalProperties: false,
                },
                permissions: {
                  type: "object",
                  properties: {
                    write_files: { type: "boolean" },
                    execute_bash: { type: "boolean" },
                    git_commit: { type: "boolean" },
                    push_to_remote: {
                      type: "boolean",
                      description: "Acción sensible: gate de permiso antes de permitir push al remoto.",
                    },
                    create_pull_request: {
                      type: "boolean",
                      description: "Acción sensible: gate de permiso antes de crear un PR.",
                    },
                    production_deploy: {
                      type: "boolean",
                      description: "Acción sensible: gate de permiso antes de desplegar a producción.",
                    },
                  },
                  additionalProperties: false,
                },
                strict_scope: {
                  type: "boolean",
                  description:
                    "Si es true y hay allowed_files, bloquea la edición de cualquier archivo fuera de la lista.",
                },
                model: {
                  type: "string",
                  description: "Override de modelo, formato providerID/modelID.",
                },
                worktree: {
                  type: "boolean",
                  description:
                    "Ejecuta la tarea en un git worktree aislado (carpeta y rama propias). Recomendado para tareas que escriben código.",
                },
              },
              required: ["id", "agent", "objective"],
              additionalProperties: true,
            },
          },
          runId: {
            type: "string",
            description:
              "ID del run elegido por el orquestador (ej. RUN-TASK-101). Permite recuperar el estado aunque se pierda el resultado.",
          },
          keepSessions: {
            type: "boolean",
            description: "Si es true, conserva las sesiones hijas para inspección.",
          },
          context: {
            type: "object",
            properties: {
              summary: { type: "string" },
              engram_ids: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
          cleanupWorktrees: {
            type: "boolean",
            description:
              "Si es true, elimina los worktrees de tareas exitosas al terminar el run (los de tareas fallidas se conservan).",
          },
        },
        required: ["objective", "tasks"],
        additionalProperties: false,
      },
      options: { namespace: "aiapaec", codemode: false },
      execute: async (input: any, context: any) => {
        const payload = input as OrchestrateInput & {
          runId?: string
          cleanupWorktrees?: boolean
        }

        // qaLevel se normaliza antes de validar: el declarado manda, ausente es
        // L2 y un valor inválido cae a L2 con aviso (no aborta el plan).
        // Los títulos del árbol se resuelven aquí una sola vez: declarado o
        // primera línea del objective (60 caracteres).
        const normalizedQa = normalizeQaLevels(payload.tasks ?? [])
        const tasks: TaskSpec[] = normalizedQa.tasks.map((task) => ({
          ...task,
          title: normalizeTitle(task.title) ?? shortTitle(task.objective),
        }))
        const qaLevelWarnings = normalizedQa.warnings
        const runTitle = normalizeTitle(payload.title) ?? shortTitle(payload.objective)

        const knownAgents = await listAgentIds(ctx)
        if (!knownAgents) {
          return {
            content:
              "❌ No se pudo listar los agentes de OpenCode (fallo transitorio). Reintenta en unos segundos.",
            metadata: { ok: false },
          }
        }

        const missing = Array.from(
          new Set(tasks.map((task) => task.agent).filter((agent) => !knownAgents.has(agent))),
        )

        if (missing.length > 0) {
          return {
            content: missingAgentsMessage(missing),
            metadata: { ok: false, missingAgents: missing },
          }
        }

        const taskErrors = validateTasks(tasks)
        if (taskErrors.length > 0) {
          return {
            content: `❌ El plan tiene errores:\n\n${taskErrors.map((error) => `- ${error}`).join("\n")}`,
            metadata: { ok: false },
          }
        }

        const keepSessions = payload.keepSessions ?? !settings.cleanupSessions
        const projectID = ctx.location.project?.id

        if (tasks.some((task) => task.worktree === true) && !projectID) {
          return {
            content:
              "❌ Hay tareas con `worktree: true`, pero esta ubicación no expone projectID; no se puede crear el worktree.",
            metadata: { ok: false },
          }
        }

        const runId = normalizeRunId(payload.runId) ?? generateRunId()
        const startedAt = new Date().toISOString()

        if (activeRuns.has(runId)) {
          return {
            content: `❌ Ya hay un run activo con el id \`${runId}\`. Consulta \`aiapaec_run_status\` o espera a que termine.`,
            metadata: { ok: false, runId },
          }
        }

        const existing = await getRun(ctx, runId)
        if (existing) {
          return {
            content: `❌ Ya existe un run con el id \`${runId}\` (estado: ${existing.status}). Usa otro ID para no sobrescribir el historial.`,
            metadata: { ok: false, runId },
          }
        }

        const control: RunControl = { aborted: false, sessions: new Set(), planDocWarnings: [] }
        activeRuns.set(runId, control)

        // Feed de actividad: la sesión orquestadora se observa desde ya y cada
        // hija se registra al crearse (onTaskStart). Todo best-effort.
        const feed = getActivityFeed()
        feed.ensureSubscribed(ctx as unknown as ActivityEventCtx)
        const parentSessionID = typeof context?.sessionID === "string" ? context.sessionID : undefined
        if (parentSessionID) {
          feed.register(parentSessionID, "orquestador", { runId, role: "orchestrator" })
        }

        const inFlight: InFlightTask[] = []
        let latestResults: readonly TaskResult[] = []

        const base: RunRecord = {
          runId,
          objective: payload.objective,
          title: runTitle,
          baseBranch: settings.baseBranch,
          startedAt,
          status: "running",
          totalTasks: tasks.length,
          inFlight: [],
          results: [],
        }

        try {
          await saveRun(ctx, base)
        } catch (error) {
          activeRuns.delete(runId)
          return {
            content: `❌ No se pudo inicializar el run en storage: ${
              error instanceof Error ? error.message : String(error)
            }. No se inició nada.`,
            metadata: { ok: false, runId },
          }
        }

        if (settings.planDocs !== false) {
          const planDocsState: PlanDocsState = {
            workdir: settings.workdir,
            folder: settings.planDocs,
            runId,
            objective: payload.objective,
            title: runTitle,
            baseBranch: settings.baseBranch,
            startedAt,
            status: "running",
            contextSummary: payload.context?.summary,
            tasks: tasks.map((task) => ({
              id: task.id,
              agent: task.agent,
              objective: task.objective,
              title: task.title,
              branch: task.branch,
              dependsOn: task.dependsOn,
            })),
            results: [],
            inFlight: [],
          }
          try {
            await writePlanDocs(planDocsState)
            control.planDocs = planDocsState
          } catch (error) {
            activeRuns.delete(runId)
            return {
              content: `❌ No se pudo inicializar el plan de documentación: ${
                error instanceof Error ? error.message : String(error)
              }. No se inició nada.`,
              metadata: { ok: false, runId },
            }
          }
        }

        const execution = runOrchestration({
          ctx,
          input: { ...payload, tasks },
          baseBranch: settings.baseBranch,
          workdir: settings.workdir,
          runId,
          keepSessions,
          parentSessionID,
          projectID,
          worktreeParent: settings.worktreeParent,
          cleanupWorktrees: payload.cleanupWorktrees ?? settings.cleanupWorktrees,
          taskTimeoutMs: settings.taskTimeoutMs,
          control,
          onUpdate: async ({ results }) => {
            const decorated = withTaskMetadata(results, tasks)
            latestResults = decorated
            const finished = new Set(decorated.map((entry) => entry.taskId))
            const pending = inFlight.filter((entry) => !finished.has(entry.taskId))
            for (const entry of decorated) {
              if (entry.sessionID) feed.unregister(entry.sessionID)
            }
            if (control.planDocs) {
              control.planDocs.results = decorated
              control.planDocs.inFlight = pending
              try {
                await writePlanDocs(control.planDocs)
              } catch (error) {
                addPlanDocWarning(control, control.planDocs.runId, error)
              }
            }
            try {
              await saveRun(ctx, {
                ...base,
                results: decorated,
                inFlight: pending,
                planDocWarnings: control.planDocWarnings,
              })
            } catch {
              // best-effort
            }
          },
          onTaskStart: async ({ taskId, agent, branch, sessionID, model, title, startedAt }) => {
            if (!inFlight.some((entry) => entry.taskId === taskId)) {
              inFlight.push(
                toInFlightTask({
                  taskId,
                  agent,
                  ...(model ? { model } : {}),
                  ...(branch ? { branch } : {}),
                  ...(startedAt ? { startedAt } : {}),
                  ...(title ? { title } : {}),
                }),
              )
            }
            if (sessionID) {
              feed.register(sessionID, taskId, {
                runId,
                taskId,
                role: "task",
                agent,
                ...(parentSessionID ? { parentID: parentSessionID } : {}),
                ...(model ? { model } : {}),
                ...(title ? { title } : {}),
              })
            }
            if (control.planDocs) {
              control.planDocs.inFlight = [...inFlight]
              try {
                await writePlanDocs(control.planDocs)
              } catch (error) {
                addPlanDocWarning(control, control.planDocs.runId, error)
              }
            }
            try {
              await saveRun(ctx, {
                ...base,
                results: [...latestResults],
                inFlight: [...inFlight],
                planDocWarnings: control.planDocWarnings,
              })
            } catch {
              // best-effort
            }
          },
        })
          .then(async (result): Promise<RunRecord> => {
            activeRuns.delete(runId)
            feed.unregisterRun(runId)
            const finalResults = withTaskMetadata(result.results, tasks)
            const record: RunRecord = {
              ...base,
              finishedAt: result.finishedAt,
              status: control.aborted ? "aborted" : "completed",
              results: finalResults,
              planDocWarnings: control.planDocWarnings,
            }
            if (control.planDocs) {
              control.planDocs.results = finalResults
              control.planDocs.inFlight = []
              control.planDocs.status = record.status
              control.planDocs.finishedAt = record.finishedAt
              try {
                await writePlanDocs(control.planDocs)
              } catch (planError) {
                addPlanDocWarning(control, control.planDocs.runId, planError)
              }
            }
            try {
              await saveRun(ctx, record)
            } catch {
              // best-effort
            }
            await pruneRuns(ctx, settings.runHistory).catch(() => undefined)
            return record
          })
          .catch(async (error): Promise<RunRecord> => {
            activeRuns.delete(runId)
            feed.unregisterRun(runId)
            const record: RunRecord = {
              ...base,
              finishedAt: new Date().toISOString(),
              status: control.aborted ? "aborted" : "failed",
              error: error instanceof Error ? error.message : String(error),
              planDocWarnings: control.planDocWarnings,
            }
            if (control.planDocs) {
              control.planDocs.results = [...latestResults]
              control.planDocs.inFlight = []
              control.planDocs.status = record.status
              control.planDocs.finishedAt = record.finishedAt
              try {
                await writePlanDocs(control.planDocs)
              } catch (planError) {
                addPlanDocWarning(control, control.planDocs.runId, planError)
              }
            }
            try {
              await saveRun(ctx, record)
            } catch {
              // best-effort
            }
            return record
          })

        // Modo segundo plano: no esperamos el resultado. Si esta llamada se
        // interrumpe, el trabajo continúa y el estado queda en el storage.
        void execution

        const written = [
          `## ▶️ Orquestación iniciada — ${payload.objective}`,
          "",
          `**runId:** \`${runId}\` · **Tareas:** ${tasks.length} · **Base:** \`${settings.baseBranch}\``,
          "",
          "El trabajo corre en segundo plano: las sesiones hijas siguen aunque esta llamada se interrumpa.",
          `Consulta el avance con \`aiapaec_run_status\` usando \`runId: "${runId}"\`. No relances el run sin verificar su estado.`,
        ]
        if (qaLevelWarnings.length > 0) {
          written.push("", "## ⚠️ Avisos de `qaLevel`", "", ...qaLevelWarnings.map((warning) => `- ${warning}`))
        }
        const dashboard = dashboardLine(settings)
        if (dashboard) written.push("", dashboard)

        return {
          content: written.join("\n"),
          metadata: {
            ok: true,
            runId,
            status: "running",
            totalTasks: tasks.length,
            ...(qaLevelWarnings.length > 0 ? { qaLevelWarnings } : {}),
            ...(settings.dashboard ? { dashboard: settings.dashboard.url } : {}),
          },
        }
      },
    })

    editor.add({
      name: "run_status",
      description:
        "Consulta el estado de una orquestación por runId (o lista los runs recientes si no se indica). " +
        "Devuelve la tabla de tareas, los reportes consolidados y los errores. Úsala para recuperar el resultado " +
        "cuando la llamada original se interrumpió.",
      input: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "ID del run. Si se omite, lista las orquestaciones recientes.",
          },
        },
        additionalProperties: false,
      },
      options: { namespace: "aiapaec", codemode: false },
      execute: async (input: any) => {
        const runId = typeof input?.runId === "string" ? input.runId.trim() : ""

        try {
          if (runId) {
            const record = await getRun(ctx, runId)
            if (!record) {
              return {
                content: `❌ No existe un run con el id \`${runId}\`. Usa \`aiapaec_run_status\` sin argumentos para ver los recientes.`,
                metadata: { ok: false },
              }
            }
            const orphan = record.status === "running" && !activeRuns.has(runId)
            const planLine =
              settings.planDocs !== false
                ? `**Plan:** ${planDocsRelativePath({ folder: settings.planDocs, runId: record.runId })}`
                : ""
            const contentParts = [formatRunRecord(record, { lastAction: lastActionResolver(record) })]
            if (planLine) contentParts.push("", planLine)
            const dashboard = dashboardLine(settings)
            if (dashboard) contentParts.push("", dashboard)
            if (orphan) {
              contentParts.push(
                "",
                "⚠️ Sin proceso activo en este servicio (posible run huérfano tras un reinicio). Puedes cerrarlo con `aiapaec_run_abort`.",
              )
            }
            if (record.planDocWarnings && record.planDocWarnings.length > 0) {
              contentParts.push(
                "",
                "## ⚠️ Advertencias del documento de plan",
                "",
                ...record.planDocWarnings.map((warning) => `- ${warning}`),
              )
            }

            return {
              content: contentParts.join("\n"),
              metadata: {
                ok: true,
                runId: record.runId,
                status: record.status,
                done: record.results.length,
                totalTasks: record.totalTasks,
                results: record.results,
                ...(settings.dashboard ? { dashboard: settings.dashboard.url } : {}),
              },
            }
          }

          const runs = await recentRuns(ctx, 8)
          if (runs.length === 0) {
            return { content: "No hay orquestaciones registradas todavía.", metadata: { ok: true, runs: 0 } }
          }

          const dashboard = dashboardLine(settings)
          const list = [formatRunsList(runs)]
          if (dashboard) list.push("", dashboard)

          return {
            content: list.join("\n"),
            metadata: {
              ok: true,
              runs: runs.length,
              ...(settings.dashboard ? { dashboard: settings.dashboard.url } : {}),
            },
          }
        } catch (error) {
          return {
            content: `❌ No se pudo leer el estado de los runs: ${
              error instanceof Error ? error.message : String(error)
            }`,
            metadata: { ok: false },
          }
        }
      },
    })

    editor.add({
      name: "run_abort",
      description:
        "Cancela un run en curso por runId: interrumpe las sesiones hijas activas y las tareas pendientes quedan como skipped.",
      input: {
        type: "object",
        properties: {
          runId: { type: "string", description: "ID del run a cancelar." },
        },
        required: ["runId"],
        additionalProperties: false,
      },
      options: { namespace: "aiapaec", codemode: false },
      execute: async (input: any) => {
        const runId = typeof input?.runId === "string" ? input.runId.trim() : ""
        if (!runId) {
          return { content: "Indica el `runId` a cancelar.", metadata: { ok: false } }
        }

        const control = activeRuns.get(runId)
        if (!control) {
          const record = await getRun(ctx, runId).catch(() => undefined)

          if (record && record.status === "running") {
            const orphan: RunRecord = {
              ...record,
              status: "aborted",
              finishedAt: new Date().toISOString(),
              error: "Abortado sin proceso activo (servicio reiniciado)",
            }
            try {
              await saveRun(ctx, orphan)
            } catch {
              // best-effort
            }
            return {
              content: `⏹️ El run \`${runId}\` estaba en \`running\` sin proceso activo (servicio reiniciado). Marcado como \`aborted\`.`,
              metadata: { ok: true, runId, orphan: true },
            }
          }

          return {
            content: record
              ? `❌ El run \`${runId}\` no está activo (estado: ${record.status}); no hay nada que abortar.`
              : `❌ No existe un run con el id \`${runId}\`.`,
            metadata: { ok: false },
          }
        }

        control.aborted = true
        let interrupted = 0
        for (const sessionID of [...control.sessions]) {
          try {
            await ctx.session.interrupt({ sessionID, resume: false })
            interrupted++
          } catch {
            // La sesión pudo haber terminado entre el snapshot y el interrupt.
          }
        }

        if (control.planDocs) {
          control.planDocs.status = "aborted"
          control.planDocs.finishedAt = new Date().toISOString()
          control.planDocs.inFlight = []
          try {
            await writePlanDocs(control.planDocs)
          } catch (error) {
            addPlanDocWarning(control, control.planDocs.runId, error)
          }
        }

        return {
          content: [
            `⏹️ Abort solicitado para \`${runId}\`.`,
            `Sesiones interrumpidas: ${interrupted}.`,
            "Las tareas pendientes se marcarán como skipped.",
            `Consulta el estado final con \`aiapaec_run_status\` (runId \`${runId}\`).`,
          ].join("\n"),
          metadata: { ok: true, runId, interrupted },
        }
      },
    })

    editor.add({
      name: "engram_status",
      description:
        "Diagnóstico de la integración Engram en OpenCode: conectado, registrado sin conexión, o ausente (con instrucciones de instalación).",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      options: { namespace: "gentle", codemode: false },
      execute: async () => {
        const status = await detectEngram(ctx)
        return {
          content: formatEngramStatus(status),
          metadata: { state: status.state, serverName: status.serverName },
        }
      },
    })
  })
}

async function listAgentIds(ctx: PluginCtx): Promise<Set<string> | undefined> {
  try {
    const output: any = await ctx.agent.list()
    const data = Array.isArray(output) ? output : (output?.data ?? [])
    return new Set(
      data
        .map((agent: any) => agent?.id)
        .filter((id: unknown): id is string => typeof id === "string"),
    )
  } catch {
    return undefined
  }
}

function missingAgentsMessage(missing: string[]): string {
  const expected = Object.keys(AGENTS).join(", ")
  return [
    `❌ Faltan agentes en la configuración de OpenCode: ${missing.join(", ")}`,
    "",
    `Agentes esperados: ${expected}`,
    "Agrégalos al campo `agents` de tu opencode.json (el bloque exacto está en el README del plugin, sección «Instalación»).",
  ].join("\n")
}

function generateRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-")}`
}

function addPlanDocWarning(control: RunControl, runId: string, error: unknown): void {
  const message = `[planDocs] No se pudo actualizar ${runId}: ${error instanceof Error ? error.message : String(error)}`
  if (!control.planDocWarnings) control.planDocWarnings = []
  control.planDocWarnings.push(message)
}

/** Línea con la URL del dashboard local, si está activo en esta instancia. */
function dashboardLine(settings: ToolSettings): string | undefined {
  return settings.dashboard ? `Dashboard: ${settings.dashboard.url}` : undefined
}

/**
 * Resolver de "última acción" por tarea para `run_status`: lee el feed en RAM
 * (best-effort; si no hay datos la línea se omite).
 */
function lastActionResolver(record: RunRecord) {
  const feed = getActivityFeed()
  const now = new Date()
  return (taskId: string) => {
    try {
      const item = feed.lastForTask(record.runId, taskId)
      return item ? { tool: item.tool, summary: item.summary, ago: formatTimeAgo(item.at, now) } : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Adjunta a cada resultado los metadatos efectivos de su tarea (`qaLevel`
 * declarado o default L2, las `skills` deduplicadas y el `title` corto). El
 * runner no los resuelve: es responsabilidad de la tool, que es quien conoce el
 * `TaskSpec` original y persiste el `RunRecord` que leen `aiapaec_run_status` y
 * el dashboard. El `model` NO se toca: lo resuelve el runner (modelo real).
 */
function withTaskMetadata(results: readonly TaskResult[], tasks: readonly TaskSpec[]): TaskResult[] {
  const levels = new Map(tasks.map((task) => [task.id, resolveQaLevel(task)]))
  const skills = new Map(tasks.map((task) => [task.id, normalizeSkills(task.skills)]))
  const titles = new Map(tasks.map((task) => [task.id, task.title ?? shortTitle(task.objective)]))
  return results.map((result) => {
    const declaredSkills = skills.get(result.taskId) ?? []
    const effectiveSkills = declaredSkills.length > 0 ? declaredSkills : result.skills
    return {
      ...result,
      qaLevel: isQaLevel(result.qaLevel)
        ? result.qaLevel
        : (levels.get(result.taskId) ?? DEFAULT_QA_LEVEL),
      ...(result.title ? {} : { title: titles.get(result.taskId) ?? result.taskId }),
      ...(effectiveSkills && effectiveSkills.length > 0 ? { skills: effectiveSkills } : {}),
    }
  })
}

/** Título declarado normalizado (espacios colapsados, 60 caracteres). */
function normalizeTitle(raw?: string): string | undefined {
  if (typeof raw !== "string") return undefined
  const text = shortTitle(raw)
  return text || undefined
}

function normalizeRunId(raw?: string): string | undefined {
  if (typeof raw !== "string") return undefined
  const cleaned = raw
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)
  return cleaned || undefined
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

function formatRunRecord(
  record: RunRecord,
  options: {
    lastAction?: (taskId: string) => { tool: string; summary: string; ago: string } | undefined
  } = {},
): string {
  const done = record.results.length
  const ok = record.results.filter((result) => result.status === "succeeded").length
  const failed = record.results.filter((result) => result.status === "failed").length
  const skipped = record.results.filter((result) => result.status === "skipped").length
  const unconfirmed = record.results.filter((result) => result.status === "unconfirmed").length

  const lines: string[] = [
    `## Orquestación — ${record.title || shortTitle(record.objective) || record.runId}`,
    "",
    `**Objetivo:** ${record.objective}`,
    "",
    `**Run:** \`${record.runId}\` · **Estado:** ${statusIcon(record.status)} ${record.status} · **Progreso:** ${done}/${record.totalTasks}`,
  ]

  if (record.finishedAt) {
    lines.push(`**Inicio:** ${record.startedAt} · **Fin:** ${record.finishedAt}`)
  }

  if (record.error) {
    lines.push(`**Error:** ${record.error}`)
  }

  if (record.results.length > 0) {
    lines.push("", "| Tarea | Agente | Estado | Tiempo | Rama |", "|---|---|---|---|---|")
    for (const result of record.results) {
      const time = result.latencyMs ? `${(result.latencyMs / 1000).toFixed(1)}s` : "—"
      const agentParts = [result.agent, result.qaLevel].filter(
        (part): part is string => typeof part === "string" && part.length > 0,
      )
      if (result.skills && result.skills.length > 0) agentParts.push(result.skills.join("+"))
      if (result.model) agentParts.push(result.model)
      const agent = agentParts.join(" · ")
      lines.push(
        `| ${escapeCell(result.taskId)} | ${escapeCell(agent)} | ${statusIcon(result.status)} ${result.status} | ${time} | ${escapeCell(result.branch ?? "—")} |`,
      )
    }

    for (const result of record.results) {
      lines.push("", `### ${result.taskId} — ${result.title || result.agent}`)
      if (result.status === "succeeded") {
        lines.push(result.summary ?? "(sin resumen)")
        if (result.sessionID) lines.push("", `*Sesión: ${result.sessionID}*`)
        if (result.worktreeDirectory) {
          lines.push(
            "",
            result.worktreeRemoved
              ? `*Worktree: \`${result.worktreeDirectory}\` (eliminado)*`
              : `*Worktree: \`${result.worktreeDirectory}\`*`,
          )
        }
        if (result.gated) lines.push("", "*Gate de permiso: aprobado (acción sensible)*")
      } else if (result.status === "unconfirmed") {
        lines.push(result.summary ?? "(sin resumen)")
        lines.push("", `⚠️ ${result.error ?? "Sin reporte estructurado"}`)
        if (result.worktreeDirectory) {
          lines.push("", `*Worktree conservado: \`${result.worktreeDirectory}\`*`)
        }
      } else {
        lines.push(`**Error:** ${result.error ?? "desconocido"}`)
        if (result.worktreeDirectory) {
          lines.push("", `*Worktree conservado: \`${result.worktreeDirectory}\`*`)
        }
      }
    }
  }

  if (record.status === "running") {
    const running = inFlightEntries(record.inFlight)
    if (running.length > 0) {
      lines.push(
        "",
        `**En curso:** ${running
          .map((entry) => `\`${entry.taskId}\` (${entry.agent} · ${entry.model ?? DEFAULT_MODEL_LABEL})`)
          .join(", ")}`,
      )
      for (const entry of running) {
        const detail = [entry.title, entry.agent, entry.model ?? DEFAULT_MODEL_LABEL]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join(" · ")
        const last = options.lastAction?.(entry.taskId)
        const action = last
          ? ` · última acción: ${escapeCell(last.tool)} → ${escapeCell(
              last.summary || "(sin argumentos)",
            )} (${escapeCell(last.ago)})`
          : ""
        lines.push(`- \`${escapeCell(entry.taskId)}\`${detail ? ` · ${escapeCell(detail)}` : ""}${action}`)
      }
    }
    lines.push(
      "",
      `⏳ En curso: ${done}/${record.totalTasks} tareas cerradas. Consulta de nuevo \`aiapaec_run_status\` con \`runId: "${record.runId}"\`.`,
    )
  } else {
    const parts = [`${ok} ✅`]
    if (failed > 0) parts.push(`${failed} ❌`)
    if (skipped > 0) parts.push(`${skipped} ⏭️`)
    if (unconfirmed > 0) parts.push(`${unconfirmed} ⚠️`)
    if (record.status === "aborted") parts.push("run abortado")
    lines.push("", `Resumen: ${parts.join(" · ")}`)
  }

  return lines.join("\n")
}

function formatRunsList(runs: RunRecord[]): string {
  const lines = [
    "## Orquestaciones recientes",
    "",
    "| Run | Objetivo | Estado | Progreso |",
    "|---|---|---|---|",
  ]

  for (const run of runs) {
    lines.push(
      `| \`${run.runId}\` | ${escapeCell(run.title || shortTitle(run.objective) || "—")} | ${statusIcon(run.status)} ${run.status} | ${run.results.length}/${run.totalTasks} |`,
    )
  }

  lines.push("", "Consulta una con `aiapaec_run_status` y su `runId`.")
  return lines.join("\n")
}
