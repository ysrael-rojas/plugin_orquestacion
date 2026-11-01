import { AGENTS } from "./agents"
import { detectEngram, formatEngramStatus } from "./engram"
import { getRun, recentRuns, saveRun } from "./history"
import { runOrchestration, validateTasks } from "./runner"
import type { OrchestrateInput, PluginCtx, RunRecord, TaskResult } from "./types"

export interface ToolSettings {
  baseBranch: string
  cleanupSessions: boolean
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
                  },
                  additionalProperties: false,
                },
                model: {
                  type: "string",
                  description: "Override de modelo, formato providerID/modelID.",
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
          wait: {
            type: "boolean",
            description: "Si es true, espera el resultado completo (útil para planes cortos).",
          },
        },
        required: ["objective", "tasks"],
        additionalProperties: false,
      },
      options: { namespace: "aiapaec", codemode: false },
      execute: async (input: any) => {
        const payload = input as OrchestrateInput & { runId?: string; wait?: boolean }

        const knownAgents = await listAgentIds(ctx)
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

        const engram = await detectEngram(ctx)
        const keepSessions = payload.keepSessions ?? !settings.cleanupSessions
        const runId = normalizeRunId(payload.runId) ?? generateRunId()
        const startedAt = new Date().toISOString()

        const base: RunRecord = {
          runId,
          objective: payload.objective,
          baseBranch: settings.baseBranch,
          startedAt,
          status: "running",
          totalTasks: payload.tasks.length,
          results: [],
        }

        try {
          await saveRun(ctx, base)
        } catch {
          // El estado es best-effort; no impide ejecutar.
        }

        const execution = runOrchestration({
          ctx,
          input: payload,
          baseBranch: settings.baseBranch,
          workdir: settings.workdir,
          keepSessions,
          onUpdate: async ({ results }) => {
            try {
              await saveRun(ctx, { ...base, results: [...results] })
            } catch {
              // best-effort
            }
          },
        })
          .then(async (result): Promise<RunRecord> => {
            const record: RunRecord = {
              ...base,
              finishedAt: result.finishedAt,
              status: "completed",
              results: result.results,
            }
            try {
              await saveRun(ctx, record)
            } catch {
              // best-effort
            }
            return record
          })
          .catch(async (error): Promise<RunRecord> => {
            const record: RunRecord = {
              ...base,
              finishedAt: new Date().toISOString(),
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            }
            try {
              await saveRun(ctx, record)
            } catch {
              // best-effort
            }
            return record
          })

        if (payload.wait) {
          const record = await execution
          return {
            content: formatRunRecord(record, engram.state),
            metadata: {
              ok: record.status !== "failed",
              runId,
              status: record.status,
              results: record.results,
            },
          }
        }

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

        if (runId) {
          const record = await getRun(ctx, runId)
          if (!record) {
            return {
              content: `No existe un run con ID \`${runId}\`. Usa \`aiapaec_run_status\` sin argumentos para ver los recientes.`,
              metadata: { ok: false },
            }
          }
          return {
            content: formatRunRecord(record),
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

async function listAgentIds(ctx: PluginCtx): Promise<Set<string>> {
  try {
    const output: any = await ctx.agent.list()
    const data = Array.isArray(output) ? output : (output?.data ?? [])
    return new Set(
      data
        .map((agent: any) => agent?.id)
        .filter((id: unknown): id is string => typeof id === "string"),
    )
  } catch {
    return new Set()
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

function statusIcon(status: RunRecord["status"] | TaskResult["status"]): string {
  switch (status) {
    case "running":
      return "⏳"
    case "completed":
    case "succeeded":
      return "✅"
    case "failed":
      return "❌"
    case "skipped":
      return "⏭️"
    default:
      return "•"
  }
}

function formatRunRecord(record: RunRecord, engramState?: string): string {
  const done = record.results.length
  const ok = record.results.filter((result) => result.status === "succeeded").length
  const failed = record.results.filter((result) => result.status === "failed").length
  const skipped = record.results.filter((result) => result.status === "skipped").length

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

  if (engramState && engramState !== "connected") {
    lines.push("", "⚠️ Engram no está conectado; la memoria persistente no participó en esta ejecución.")
  }

  if (record.results.length > 0) {
    lines.push("", "| Tarea | Agente | Estado | Tiempo | Rama |", "|---|---|---|---|---|")
    for (const result of record.results) {
      const time = result.latencyMs ? `${(result.latencyMs / 1000).toFixed(1)}s` : "—"
      lines.push(
        `| ${result.taskId} | ${result.agent} | ${statusIcon(result.status)} ${result.status} | ${time} | ${result.branch ?? "—"} |`,
      )
    }

    for (const result of record.results) {
      lines.push("", `### ${result.taskId} — ${result.agent}`)
      if (result.status === "succeeded") {
        lines.push(result.summary ?? "(sin resumen)")
        if (result.sessionID) lines.push("", `*Sesión: ${result.sessionID}*`)
      } else {
        lines.push(`**Error:** ${result.error ?? "desconocido"}`)
      }
    }
  }

  if (record.status === "running") {
    lines.push(
      "",
      `⏳ En curso: ${done}/${record.totalTasks} tareas cerradas. Consulta de nuevo \`aiapaec_run_status\` con \`runId: "${record.runId}"\`.`,
    )
  } else if (failed > 0 || skipped > 0) {
    lines.push("", `Resumen: ${ok} ✅ · ${failed} ❌ · ${skipped} ⏭️`)
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
      `| \`${run.runId}\` | ${run.objective} | ${statusIcon(run.status)} ${run.status} | ${run.results.length}/${run.totalTasks} |`,
    )
  }

  lines.push("", "Consulta una con `aiapaec_run_status` y su `runId`.")
  return lines.join("\n")
}
