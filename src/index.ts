import { Plugin } from "@opencode/plugin"

import { AGENTS } from "./agents"
import { detectEngram, formatEngramStatus } from "./engram"
import { registerTools } from "./tools"
import type { PluginCtx } from "./types"

/**
 * Plugin de orquestación para OpenCode V2 (arquitectura Gentle Shell).
 *
 * Registra:
 *  - Herramientas de namespace `gentle`: `orchestrate` y `engram_status`.
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
    const workdir = ctx.location?.directory ?? process.cwd()

    const tools = await registerTools(ctx, { baseBranch, cleanupSessions, workdir })

    const commands = await ctx.command.transform((editor: any) => {
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
