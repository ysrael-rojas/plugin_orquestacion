import { Plugin } from "@opencode/plugin"

import { AGENTS } from "./agents"
import { detectEngram, formatEngramStatus } from "./engram"
import { registerTools } from "./tools"
import { registerSkills } from "./skills"
import type { PluginCtx, PluginOptions } from "./types"

/**
 * Plugin de orquestación para OpenCode V2 (arquitectura Aiapaec).
 *
 * Registra:
 *  - Herramientas de namespace `aiapaec`: `orchestrate` (y `run_status` en v0.2).
 *  - Herramienta de namespace `gentle`: `engram_status`.
 *  - Comando `/engram-status`.
 *
 * Los agentes (orquestador, contexto, explorador, coder, qa, deployer) se
 * definen en el campo `agents` de opencode.json: la API V2 de plugins no
 * permite crearlos desde el plugin.
 */
export default Plugin.define({
  id: "plugin-de-orquestacion-para-opencode",
  async setup(context: any) {
    const ctx = context as PluginCtx
    const options = ctx.options ?? {}

    const baseBranch =
      typeof options.baseBranch === "string" && options.baseBranch.trim()
        ? options.baseBranch.trim()
        : "dev"

    const cleanupSessions = options.cleanupSessions === true
    const cleanupWorktrees = options.cleanupWorktrees === true
    const taskTimeoutMs =
      typeof options.taskTimeoutMs === "number" && options.taskTimeoutMs > 0
        ? options.taskTimeoutMs
        : undefined
    const worktreeParent =
      typeof options.worktreeParent === "string" && options.worktreeParent.trim()
        ? options.worktreeParent.trim()
        : undefined

    const skillsEnabled = options.skills !== false

    const rawRunHistory = (options as PluginOptions).runHistory
    const runHistory =
      typeof rawRunHistory === "number" && Number.isFinite(rawRunHistory) && rawRunHistory > 0
        ? Math.floor(rawRunHistory)
        : 50

    const workdir = ctx.location?.directory ?? process.cwd()

    const tools = await registerTools(ctx, {
      baseBranch,
      cleanupSessions,
      cleanupWorktrees,
      taskTimeoutMs,
      worktreeParent,
      runHistory,
      workdir,
    })

    const commands = await ctx.command.transform((editor: any) => {
      editor.add({
        name: "orquestar",
        description: "Orquesta una petición: la descompone en subagentes y delega con aiapaec_orchestrate",
        execute: async ({ sessionID, prompt, delivery }: any) => {
          await ctx.session.prompt({
            sessionID,
            delivery,
            text: [
              "Orquesta la siguiente petición usando la herramienta `aiapaec_orchestrate`.",
              "Descompón en tareas atómicas con `dependsOn`, elige tú el `runId`, usa `worktree: true` para tareas que escriban código y consulta `aiapaec_run_status` hasta que el run termine.",
              "",
              prompt.text,
            ].join("\n"),
          })
        },
      })

      editor.add({
        name: "engram-status",
        description:
          "Diagnóstico de la integración Engram (conectado / registrado sin conexión / ausente)",
        execute: async ({ sessionID }: any) => {
          const status = await detectEngram(ctx)
          await ctx.session.prompt({
            sessionID,
            text: [
              "El usuario pidió el diagnóstico de Engram.",
              "Responde mostrando el siguiente diagnóstico tal cual, sin agregar nada más:",
              "",
              formatEngramStatus(status),
            ].join("\n"),
          })
        },
      })
    })

    const skills = await registerSkills(ctx, { enabled: skillsEnabled, workdir })

    await warnMissingAgents(ctx)

    const engram = await detectEngram(ctx)
    if (engram.state !== "connected") {
      console.warn(`[plugin-orquestacion] Engram ${engram.state}: ${engram.detail}`)
    }

    return async () => {
      try {
        await tools?.dispose?.()
      } catch {
        // sin acción: el plugin se está descargando
      }
      try {
        await commands?.dispose?.()
      } catch {
        // sin acción: el plugin se está descargando
      }
      try {
        await skills?.dispose?.()
      } catch {
        // sin acción: el plugin se está descargando
      }
    }
  },
})

async function warnMissingAgents(ctx: PluginCtx): Promise<void> {
  try {
    const output: any = await ctx.agent.list()
    const data = Array.isArray(output) ? output : (output?.data ?? [])
    const ids = new Set(
      data.map((agent: any) => agent?.id).filter((id: unknown) => typeof id === "string"),
    )
    const missing = Object.keys(AGENTS).filter((id) => !ids.has(id))

    if (missing.length > 0) {
      console.warn(
        `[plugin-orquestacion] Faltan agentes en opencode.json: ${missing.join(", ")}. ` +
          "Copia el bloque de agentes del README para habilitar la delegación.",
      )
    }
  } catch {
    // La validación es informativa; no bloquea el arranque del plugin.
  }
}
