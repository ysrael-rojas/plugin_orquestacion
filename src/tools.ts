import { AGENTS } from "./agents"
import { detectEngram, formatEngramStatus } from "./engram"
import { saveRun } from "./history"
import { runOrchestration, validateTasks } from "./runner"
import type { OrchestrateInput, PluginCtx, TaskResult } from "./types"

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
        "Las tareas sin dependencias entre sí corren en paralelo; las que declaran dependsOn esperan. " +
        "Devuelve el reporte consolidado de cada subtarea. La rama base de trabajo es la configurada (por defecto 'dev').",
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
          keepSessions: {
            type: "boolean",
            description: "Si es true, conserva las sesiones hijas para inspección.",
          },
        },
        required: ["objective", "tasks"],
        additionalProperties: false,
      },
      options: { namespace: "aiapaec", codemode: false },
      execute: async (input: any) => {
        const payload = input as OrchestrateInput

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

        try {
          const result = await runOrchestration({
            ctx,
            input: payload,
            baseBranch: settings.baseBranch,
            workdir: settings.workdir,
            keepSessions,
          })

          await saveRun(ctx, {
            runId: result.runId,
            objective: payload.objective,
            baseBranch: settings.baseBranch,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            results: result.results,
          }).catch(() => undefined)

          return {
            content: formatRunResult(payload, result.runId, result.results, engram.state),
            metadata: {
              ok: true,
              runId: result.runId,
              baseBranch: settings.baseBranch,
              results: result.results,
            },
          }
        } catch (error) {
          return {
            content: `❌ Orquestación fallida: ${error instanceof Error ? error.message : String(error)}`,
            metadata: { ok: false },
          }
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

function formatRunResult(
  input: OrchestrateInput,
  runId: string,
  results: TaskResult[],
  engramState: string,
): string {
  const total = results.length
  const ok = results.filter((result) => result.status === "succeeded").length
  const failed = results.filter((result) => result.status === "failed").length
  const skipped = results.filter((result) => result.status === "skipped").length

  const lines: string[] = [
    `## Orquestación — ${input.objective}`,
    "",
    `**Run:** \`${runId}\` · **Resultado:** ${ok}/${total} ✅${failed ? ` · ${failed} ❌` : ""}${skipped ? ` · ${skipped} ⏭️` : ""}`,
  ]

  if (engramState !== "connected") {
    lines.push("", "⚠️ Engram no está conectado; la memoria persistente no participó en esta ejecución.")
  }

  lines.push("", "| Tarea | Agente | Estado | Tiempo | Rama |", "|---|---|---|---|---|")

  for (const result of results) {
    const icon =
      result.status === "succeeded" ? "✅" : result.status === "failed" ? "❌" : "⏭️"
    const time = result.latencyMs ? `${(result.latencyMs / 1000).toFixed(1)}s` : "—"
    lines.push(
      `| ${result.taskId} | ${result.agent} | ${icon} ${result.status} | ${time} | ${result.branch ?? "—"} |`,
    )
  }

  for (const result of results) {
    lines.push("", `### ${result.taskId} — ${result.agent}`)

    if (result.status === "succeeded") {
      lines.push(result.summary ?? "(sin resumen)")
      if (result.sessionID) {
        lines.push("", `*Sesión: ${result.sessionID}*`)
      }
    } else {
      lines.push(`**Error:** ${result.error ?? "desconocido"}`)
    }
  }

  return lines.join("\n")
}
