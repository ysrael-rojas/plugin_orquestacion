import { AGENTS } from "./agents"
import { detectEngram, formatEngramStatus } from "./engram"
import { getRun, pruneRuns, recentRuns, saveRun } from "./history"
import { planDocsRelativePath, statusIcon, writePlanDocs } from "./plandocs"
import { runOrchestration, validateTasks } from "./runner"
import type { OrchestrateInput, PlanDocsState, PluginCtx, RunControl, RunRecord, TaskResult } from "./types"

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
}

export function registerTools(ctx: PluginCtx, settings: ToolSettings) {
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
                dependsOn: {
                  type: "array",
                  items: { type: "string" },
                  description: "IDs de subtareas que deben completarse antes.",
                },
                branch: {
                  type: "string",
                  description: "Rama de trabajo. Por defecto feat/<id>.",
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

        const knownAgents = await listAgentIds(ctx)
        if (!knownAgents) {
          return {
            content:
              "❌ No se pudo listar los agentes de OpenCode (fallo transitorio). Reintenta en unos segundos.",
            metadata: { ok: false },
          }
        }

        const missing = Array.from(
          new Set(payload.tasks.map((task) => task.agent).filter((agent) => !knownAgents.has(agent))),
        )

        if (missing.length > 0) {
          return {
            content: missingAgentsMessage(missing),
            metadata: { ok: false, missingAgents: missing },
          }
        }

        const taskErrors = validateTasks(payload.tasks)
        if (taskErrors.length > 0) {
          return {
            content: `❌ El plan tiene errores:\n\n${taskErrors.map((error) => `- ${error}`).join("\n")}`,
            metadata: { ok: false },
          }
        }

        const keepSessions = payload.keepSessions ?? !settings.cleanupSessions
        const projectID = ctx.location.project?.id

        if (payload.tasks.some((task) => task.worktree === true) && !projectID) {
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

        const inFlight: string[] = []
        let latestResults: readonly TaskResult[] = []

        const base: RunRecord = {
          runId,
          objective: payload.objective,
          baseBranch: settings.baseBranch,
          startedAt,
          status: "running",
          totalTasks: payload.tasks.length,
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
            baseBranch: settings.baseBranch,
            startedAt,
            status: "running",
            contextSummary: payload.context?.summary,
            tasks: payload.tasks.map((task) => ({
              id: task.id,
              agent: task.agent,
              objective: task.objective,
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
          input: payload,
          baseBranch: settings.baseBranch,
          workdir: settings.workdir,
          runId,
          keepSessions,
          parentSessionID: typeof context?.sessionID === "string" ? context.sessionID : undefined,
          projectID,
          worktreeParent: settings.worktreeParent,
          cleanupWorktrees: payload.cleanupWorktrees ?? settings.cleanupWorktrees,
          taskTimeoutMs: settings.taskTimeoutMs,
          control,
          onUpdate: async ({ results }) => {
            latestResults = [...results]
            const finished = new Set(results.map((entry) => entry.taskId))
            const pending = inFlight.filter((id) => !finished.has(id))
            if (control.planDocs) {
              control.planDocs.results = [...results]
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
                results: [...results],
                inFlight: pending,
                planDocWarnings: control.planDocWarnings,
              })
            } catch {
              // best-effort
            }
          },
          onTaskStart: async ({ taskId }) => {
            if (!inFlight.includes(taskId)) inFlight.push(taskId)
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
            const record: RunRecord = {
              ...base,
              finishedAt: result.finishedAt,
              status: control.aborted ? "aborted" : "completed",
              results: result.results,
              planDocWarnings: control.planDocWarnings,
            }
            if (control.planDocs) {
              control.planDocs.results = result.results
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

        return {
          content: [
            `## ▶️ Orquestación iniciada — ${payload.objective}`,
            "",
            `**runId:** \`${runId}\` · **Tareas:** ${payload.tasks.length} · **Base:** \`${settings.baseBranch}\``,
            "",
            "El trabajo corre en segundo plano: las sesiones hijas siguen aunque esta llamada se interrumpa.",
            `Consulta el avance con \`aiapaec_run_status\` usando \`runId: "${runId}"\`. No relances el run sin verificar su estado.`,
          ].join("\n"),
          metadata: { ok: true, runId, status: "running", totalTasks: payload.tasks.length },
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
            const contentParts = [formatRunRecord(record)]
            if (planLine) contentParts.push("", planLine)
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
              },
            }
          }

          const runs = await recentRuns(ctx, 8)
          if (runs.length === 0) {
            return { content: "No hay orquestaciones registradas todavía.", metadata: { ok: true, runs: 0 } }
          }

          return { content: formatRunsList(runs), metadata: { ok: true, runs: runs.length } }
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

function formatRunRecord(record: RunRecord): string {
  const done = record.results.length
  const ok = record.results.filter((result) => result.status === "succeeded").length
  const failed = record.results.filter((result) => result.status === "failed").length
  const skipped = record.results.filter((result) => result.status === "skipped").length
  const unconfirmed = record.results.filter((result) => result.status === "unconfirmed").length

  const lines: string[] = [
    `## Orquestación — ${record.objective}`,
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
      lines.push(
        `| ${escapeCell(result.taskId)} | ${escapeCell(result.agent)} | ${statusIcon(result.status)} ${result.status} | ${time} | ${escapeCell(result.branch ?? "—")} |`,
      )
    }

    for (const result of record.results) {
      lines.push("", `### ${result.taskId} — ${result.agent}`)
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
    const running = record.inFlight ?? []
    if (running.length > 0) {
      lines.push("", `**En curso:** ${running.join(", ")}`)
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
      `| \`${run.runId}\` | ${escapeCell(run.objective)} | ${statusIcon(run.status)} ${run.status} | ${run.results.length}/${run.totalTasks} |`,
    )
  }

  lines.push("", "Consulta una con `aiapaec_run_status` y su `runId`.")
  return lines.join("\n")
}
