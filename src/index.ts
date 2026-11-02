import { Plugin } from "@opencode/plugin"

import { AGENTS } from "./agents"
import { normalizeDashboardPort, startDashboard, type DashboardHandle } from "./dashboard"
import { detectEngram, formatEngramStatus } from "./engram"
import { sanitizePlanDocsFolder } from "./plandocs"
import { registerTools } from "./tools"
import { registerSkills } from "./skills"
import {
  normalizeModelProfileName,
  ORCHESTRATOR_AGENT_ID,
  profileModel,
  resolveModelProfiles,
  splitModelRef,
} from "./types"
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

    const rawPlanDocs = (options as PluginOptions).planDocs
    const planDocs: string | false =
      rawPlanDocs === false
        ? false
        : typeof rawPlanDocs === "string"
          ? sanitizePlanDocsFolder(rawPlanDocs)
          : "docs/plans"

    const workdir = ctx.location?.directory ?? process.cwd()

    // Perfiles de modelos: built-in (`high`/`balanced`/`low`/`free`) fusionados
    // con los del usuario. El default debe existir; si no, se ignora con aviso.
    const modelProfiles = resolveModelProfiles((options as PluginOptions).modelProfiles)
    const requestedProfile = normalizeModelProfileName((options as PluginOptions).modelProfile)
    let defaultModelProfile: string | undefined
    if (requestedProfile) {
      if (modelProfiles[requestedProfile]) {
        defaultModelProfile = requestedProfile
      } else {
        console.warn(
          `[plugin-orquestacion] modelProfile "${requestedProfile}" no existe; se ignora. ` +
            `Perfiles disponibles: ${Object.keys(modelProfiles).join(", ")}.`,
        )
      }
    }

    // Orquestador: el perfil por defecto fija su modelo vía `agent.transform`
    // (best-effort, solo afecta sesiones nuevas). Un fallo aquí no rompe nada.
    const orchestratorModel = profileModel(
      defaultModelProfile ? modelProfiles[defaultModelProfile] : undefined,
      ORCHESTRATOR_AGENT_ID,
    )
    const agentRegistration = await applyOrchestratorModel(ctx, orchestratorModel)

    // Dashboard local: best-effort. Un fallo aquí nunca debe romper el plugin.
    const dashboardPort = normalizeDashboardPort((options as PluginOptions).dashboardPort)
    if (dashboardPort.warning) console.warn(dashboardPort.warning)

    let dashboard: DashboardHandle | undefined
    if (dashboardPort.port > 0) {
      try {
        dashboard = await startDashboard(ctx, dashboardPort.port)
      } catch (error) {
        console.warn(
          `[plugin-orquestacion] dashboard desactivado: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    const tools = await registerTools(ctx, {
      baseBranch,
      cleanupSessions,
      cleanupWorktrees,
      taskTimeoutMs,
      worktreeParent,
      runHistory,
      planDocs,
      workdir,
      modelProfiles,
      ...(defaultModelProfile ? { defaultModelProfile } : {}),
      ...(dashboard ? { dashboard: { port: dashboard.port, url: dashboard.url } } : {}),
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
        await dashboard?.close()
      } catch {
        // sin acción: el plugin se está descargando
      }
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
      try {
        await agentRegistration?.dispose?.()
      } catch {
        // sin acción: el plugin se está descargando
      }
    }
  },
})

/**
 * Aplica el modelo del perfil al agente orquestador vía `ctx.agent.transform`.
 *
 * Best-effort: sin `transform` en el contexto (o con un editor sin el agente)
 * devuelve `undefined` y el agente conserva el modelo de `opencode.json`. El
 * cambio solo alcanza sesiones creadas después del setup.
 */
async function applyOrchestratorModel(
  ctx: PluginCtx,
  model: string | undefined,
): Promise<{ dispose?: () => Promise<void> } | undefined> {
  if (!model) return undefined

  const ref = splitModelRef(model)
  if (!ref) {
    console.warn(
      `[plugin-orquestacion] el perfil declara un modelo inválido para ${ORCHESTRATOR_AGENT_ID}: "${model}" (formato providerID/modelID).`,
    )
    return undefined
  }

  const transform = ctx.agent?.transform
  if (typeof transform !== "function") return undefined

  try {
    return await transform.call(ctx.agent, (editor: any) => {
      if (typeof editor?.list !== "function" || typeof editor?.update !== "function") return
      const exists = (editor.list() as any[]).some((agent) => agent?.id === ORCHESTRATOR_AGENT_ID)
      if (!exists) return
      editor.update(ORCHESTRATOR_AGENT_ID, (agent: any) => {
        agent.model = { ...ref }
      })
    })
  } catch (error) {
    console.warn(
      `[plugin-orquestacion] no se pudo aplicar el perfil al orquestador: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  }
}

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
