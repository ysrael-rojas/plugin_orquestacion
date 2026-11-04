import assert from "node:assert/strict"
import fs from "node:fs"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  buildTaskPrompt,
  DEFAULT_QA_LEVEL,
  extractReport,
  normalizeQaLevels,
  normalizeSkills,
  QA_LEVELS,
  QA_LEVEL_GUIDE,
  resolveQaLevel,
} from "../src/contracts"
import {
  ACTIVITY_BUFFER_SIZE,
  ACTIVITY_SUMMARY_MAX,
  ActivityFeed,
  formatTimeAgo,
  getActivityFeed,
  summarizeToolInput,
  truncateSummary,
} from "../src/activity"
import {
  activeDashboard,
  DEFAULT_DASHBOARD_PORT,
  DASHBOARD_STATE_VERSION,
  normalizeDashboardPort,
  startDashboard,
} from "../src/dashboard"
import {
  DASHBOARD_REFRESH_MS,
  DEFAULT_DASHBOARD_URL,
  renderDashboardHtml,
  renderDetailsStateScript,
} from "../src/dashboard-html"
import { buildDashboardView, escapeHtml, formatChip, formatStamp, shortText } from "../src/dashboard-view"
import { detectEngram } from "../src/engram"
import { getRun, pruneRuns, recentRuns, saveRun } from "../src/history"
import { buildSessionPermissions } from "../src/permissions"
import { renderPlanMarkdown, sanitizePlanDocsFolder, writePlanDocs } from "../src/plandocs"
import { runOrchestration, planWaves } from "../src/runner"
import plugin from "../src/index"
import { registerTools } from "../src/tools"
import { registerSkills } from "../src/skills"
import type { PluginCtx, RunRecord, TaskSpec } from "../src/types"
import {
  BUILT_IN_MODEL_PROFILES,
  MODEL_PROFILE_PROVIDER,
  SHORT_TITLE_MAX,
  inFlightEntries,
  modelLabel,
  profileModel,
  resolveModelProfiles,
  shortTitle,
  splitModelRef,
  toInFlightTask,
} from "../src/types"
import {
  BASE_BRANCH,
  PROTECTED_BRANCHES,
  buildMergeMessage,
  isAlreadyMerged,
  isEntrypoint,
  parseArgs,
  planDocPath,
  runIdFromBranch,
  validateBranch,
  workingTreeBlockers,
} from "../scripts/cierre.mjs"
import {
  DASHBOARD_PORT,
  DASHBOARD_URL,
  browserCandidates,
  buildLaunchPlan,
  isEntrypoint as isDashboardEntrypoint,
  openDashboard,
  portWarning,
} from "../scripts/abrir-dashboard.mjs"

function makeCtx(options: { fail?: string[]; delayMs?: number; noReport?: string[] } = {}): PluginCtx {
  let counter = 0
  const created: any[] = []
  const prompts: Array<{ taskId: string; text: string }> = []
  const worktreesCreated: any[] = []
  const worktreesRemoved: any[] = []
  const permissionAsserts: any[] = []
  const interrupts: any[] = []
  const agentUpdates: Array<{ id: string; model?: any }> = []
  const agentTransformDisposals: string[] = []
  const sessions = new Map<string, { input: any; prompt?: string; messages: any[] }>()
  const storage = new Map<string, any>()

  const ctx: PluginCtx = {
    options: {},
    location: { directory: "C:/repo", project: { id: "proj_test" } },
    permission: {
      async assert(input: any) {
        permissionAsserts.push(input)
      },
    },
    worktree: {
      async create(input: any) {
        worktreesCreated.push(input)
        return { directory: `C:/worktrees/${input.name}` }
      },
      async remove(input: any) {
        worktreesRemoved.push(input)
      },
    },
    session: {
      async create(input: any) {
        created.push(input)
        const id = `ses_test_${++counter}`
        sessions.set(id, { input, messages: [] })
        return { id }
      },
      async prompt({ sessionID, text }: any) {
        const session = sessions.get(sessionID)!
        session.prompt = text
        prompts.push({ taskId: session.input?.metadata?.taskId ?? "?", text })
      },
      async wait() {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      },
      async context({ sessionID }: any) {
        const session = sessions.get(sessionID)!
        const taskId = session.input?.metadata?.taskId ?? "?"
        const shouldFail = (options.fail ?? []).includes(taskId)
        const shouldSkipReport = (options.noReport ?? []).includes(taskId)
        const text = shouldSkipReport
          ? "No pude completar la tarea (sin reporte estructurado)."
          : shouldFail
            ? "No pude completar la tarea.\n```json\n" +
              JSON.stringify({ task_id: taskId, status: "failure", summary: "falló la tarea" }) +
              "\n```"
            : "Listo.\n```json\n" +
              JSON.stringify({
                task_id: taskId,
                status: "success",
                summary: `resumen de ${taskId}`,
                artifacts: { modified_files: [], git_branch: `feat/${taskId}`, last_commit_hash: "abc" },
              }) +
              "\n```"
        return [
          {
            type: "assistant",
            // El SDK declara `model` obligatorio en el assistant: lo usamos para
            // verificar que el runner persiste el modelo REAL (no el esperado).
            model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
            content: [{ type: "text", text }],
            tokens: { input: 10, output: 5 },
          },
        ]
      },
      async update() {},
      async interrupt(input?: any) {
        interrupts.push(input ?? {})
        return undefined
      },
      async remove({ sessionID }: any) {
        sessions.delete(sessionID)
      },
    },
    storage: {
      async set(key: string, value: any) {
        storage.set(key, value)
      },
      async get(key: string) {
        return storage.get(key)
      },
      async remove(key: string) {
        storage.delete(key)
      },
      async scan() {
        return { entries: [...storage.entries()].map(([key, value]) => ({ key, value })) }
      },
    },
    mcp: { async list() { return { data: [] } } },
    agent: {
      async list() {
        return { data: ["orquestador", "contexto", "explorador", "coder", "qa", "deployer"].map((id) => ({ id })) }
      },
      // `AgentInfo.model` es opcional: `contexto` no declara modelo a propósito.
      async get({ agentID }: any) {
        const model =
          agentID === "coder"
            ? { providerID: "opencode-go", id: "deepseek-v4.1-flash" }
            : agentID === "qa"
              ? { providerID: "opencode-go", id: "glm-5.3-flash" }
              : undefined
        return { data: { id: agentID, ...(model ? { model } : {}) } }
      },
      // Mock del `AgentEditor` real (list/get/default/update/remove): aplica el
      // transform de forma síncrona y registra los updates para poder validarlos.
      async transform(callback: any) {
        const registry = new Map<string, any>([
          ["orquestador", { id: "orquestador", model: { providerID: "opencode-go", id: "glm-5.3" } }],
          ...["contexto", "explorador", "coder", "qa", "deployer"].map(
            (id) => [id, { id }] as [string, any],
          ),
        ])
        callback({
          list: () => [...registry.values()],
          get: (id: string) => registry.get(id),
          default: () => {},
          update: (id: string, apply: (agent: any) => void) => {
            const agent = registry.get(id)
            if (!agent) return
            apply(agent)
            agentUpdates.push({ id, model: agent.model })
          },
          remove: (id: string) => {
            registry.delete(id)
          },
        })
        return {
          dispose: async () => {
            agentTransformDisposals.push("orquestador")
          },
        }
      },
    },
    command: { async transform() { return { dispose: async () => {} } } },
    tool: { async transform() { return { dispose: async () => {} } } },
  }

  ;(ctx as any).__created = created
  ;(ctx as any).__prompts = prompts
  ;(ctx as any).__permissions = permissionAsserts
  ;(ctx as any).__interrupts = interrupts
  ;(ctx as any).__agentUpdates = agentUpdates
  ;(ctx as any).__agentTransformDisposals = agentTransformDisposals
  ;(ctx as any).__worktrees = { created: worktreesCreated, removed: worktreesRemoved }
  return ctx
}

test("planWaves agrupa por dependencias y detecta ciclos", () => {
  const tasks: TaskSpec[] = [
    { id: "A", agent: "explorador", objective: "a" },
    { id: "B", agent: "explorador", objective: "b" },
    { id: "C", agent: "coder", objective: "c", dependsOn: ["A", "B"] },
  ]
  const waves = planWaves(tasks)
  assert.equal(waves.length, 2)
  assert.equal(waves[0]!.length, 2)
  assert.equal(waves[1]![0]!.id, "C")

  assert.throws(() =>
    planWaves([
      { id: "X", agent: "coder", objective: "x", dependsOn: ["Y"] },
      { id: "Y", agent: "coder", objective: "y", dependsOn: ["X"] },
    ]),
  )
})

test("permisos de sesión: deny reales por archivo y flags", () => {
  const rules = buildSessionPermissions(
    {
      id: "T1",
      agent: "coder",
      objective: "x",
      permissions: { write_files: false, execute_bash: false },
      scope: { forbidden_files: ["src/config/db.ts"] },
    },
    "C:/repo",
  )
  assert.ok(rules.some((rule) => rule.action === "edit" && rule.resource === "*" && rule.effect === "deny"))
  assert.ok(rules.some((rule) => rule.action === "bash" && rule.resource === "*" && rule.effect === "deny"))
  assert.ok(rules.some((rule) => rule.resource === "src/config/db.ts"))
  assert.ok(rules.some((rule) => rule.resource === "C:/repo/src/config/db.ts"))
})

test("strict_scope convierte allowed_files en bloqueo real", () => {
  const rules = buildSessionPermissions(
    {
      id: "T2",
      agent: "coder",
      objective: "x",
      strict_scope: true,
      scope: { allowed_files: ["src/a.ts"], forbidden_files: ["src/b.ts"] },
    },
    "C:/repo",
  )

  const denyAll = rules.findIndex(
    (rule) => rule.action === "edit" && rule.resource === "*" && rule.effect === "deny",
  )
  const allowA = rules.findIndex(
    (rule) => rule.action === "edit" && rule.resource === "src/a.ts" && rule.effect === "allow",
  )
  const denyB = rules.findIndex(
    (rule) => rule.action === "edit" && rule.resource === "src/b.ts" && rule.effect === "deny",
  )

  assert.ok(denyAll >= 0, "debe existir deny global")
  assert.ok(allowA > denyAll, "la allow debe ir después del deny global")
  assert.ok(denyB > allowA, "la denegación explícita debe ir al final")
})

test("contratos: prompt con rama base y parseo tolerante del reporte", () => {
  const prompt = buildTaskPrompt({
    task: { id: "TASK-1", agent: "coder", objective: "implementar login" },
    baseBranch: "dev",
    runObjective: "login con JWT",
  })
  assert.ok(prompt.includes("feat/TASK-1"))
  assert.ok(prompt.includes("dev"))
  assert.ok(prompt.includes("TASK-1"))

  const fenced = extractReport('texto\n```json\n{"task_id":"T","summary":"s"}\n```\n')
  assert.deepEqual(fenced, { task_id: "T", summary: "s" })
  assert.equal(extractReport('{"a":1}'), undefined, "un JSON sin forma de reporte se descarta")
  assert.equal(extractReport("sin json"), undefined)
})

test("qaLevel: default L2, valores válidos y caída a L2 con aviso", () => {
  assert.deepEqual(QA_LEVELS, ["L1", "L2", "L3"])
  assert.equal(DEFAULT_QA_LEVEL, "L2")
  assert.equal(resolveQaLevel({}), "L2")
  assert.equal(resolveQaLevel({ qaLevel: "L3" }), "L3")
  assert.equal(resolveQaLevel({ qaLevel: "l3" as any }), "L2", "un nivel inválido resuelve a L2")

  const normalized = normalizeQaLevels([
    { id: "Q1", agent: "qa", objective: "smoke", qaLevel: "L1" },
    { id: "Q2", agent: "qa", objective: "sin nivel" },
    { id: "Q3", agent: "qa", objective: "nivel roto", qaLevel: "L9" as any },
  ])

  assert.equal(normalized.tasks[0]!.qaLevel, "L1")
  assert.equal(normalized.tasks[1]!.qaLevel, undefined, "sin declarar queda en default L2 aguas abajo")
  assert.equal(normalized.tasks[2]!.qaLevel, "L2", "el inválido cae a L2")
  assert.equal(normalized.warnings.length, 1)
  assert.match(normalized.warnings[0]!, /Q3/)
  assert.match(normalized.warnings[0]!, /L9/)
  assert.match(normalized.warnings[0]!, /L1, L2, L3/)
})

test("contratos: el prompt de qa incluye la definición operativa del nivel", () => {
  const base = { baseBranch: "dev", runObjective: "validar el cambio" }

  const l1 = buildTaskPrompt({
    ...base,
    task: { id: "QA1", agent: "qa", objective: "smoke", qaLevel: "L1" },
  })
  assert.match(l1, /## Nivel de QA — L1/)
  assert.ok(l1.includes(QA_LEVEL_GUIDE.L1))
  assert.ok(!l1.includes(QA_LEVEL_GUIDE.L2), "solo la definición del nivel efectivo")
  assert.match(l1, /"qa_level": "L1"/, "el contrato de entrada declara el nivel")

  const l3 = buildTaskPrompt({
    ...base,
    task: { id: "QA3", agent: "qa", objective: "forense", qaLevel: "L3" },
  })
  assert.match(l3, /## Nivel de QA — L3/)
  assert.ok(l3.includes(QA_LEVEL_GUIDE.L3))
  assert.ok(l3.includes(".d.ts"), "L3 exige contrastar supuestos contra fuentes reales")

  const byDefault = buildTaskPrompt({
    ...base,
    task: { id: "QA2", agent: "qa", objective: "sin nivel" },
  })
  assert.match(byDefault, /## Nivel de QA — L2/, "sin qaLevel el nivel efectivo es L2")
  assert.ok(byDefault.includes(QA_LEVEL_GUIDE.L2))

  const coder = buildTaskPrompt({
    ...base,
    task: { id: "C1", agent: "coder", objective: "implementar" },
  })
  assert.ok(!coder.includes("## Nivel de QA"), "el nivel solo se inyecta en tareas de qa")
})

test("skills: normalización sin duplicados y sección condicional en el prompt", () => {
  assert.deepEqual(
    normalizeSkills(["tdd", " tdd ", "code-review", 42, "", null]),
    ["tdd", "code-review"],
    "descarta no-strings/vacíos y deduplica sin distinguir mayúsculas",
  )
  assert.deepEqual(normalizeSkills("tdd"), [], "una forma inesperada devuelve lista vacía, no rompe")
  assert.deepEqual(normalizeSkills(undefined), [])

  const base = { baseBranch: "dev", runObjective: "implementar" }

  const withSkills = buildTaskPrompt({
    ...base,
    task: {
      id: "C1",
      agent: "coder",
      objective: "implementar",
      skills: ["tdd", "tdd", "code-review"],
    },
  })
  assert.match(withSkills, /## Skills a aplicar/)
  assert.equal((withSkills.match(/`tdd`/g) ?? []).length, 1, "sin duplicados en el prompt")
  assert.match(withSkills, /invócala/)
  assert.match(withSkills, /aplica su disciplina/, "sin la skill disponible se aplica su disciplina")

  const weird = buildTaskPrompt({
    ...base,
    task: { id: "C2", agent: "coder", objective: "valores raros", skills: ["", 7] as any },
  })
  assert.ok(!weird.includes("## Skills a aplicar"), "sin skills válidas no se inyecta la sección")

  const without = buildTaskPrompt({
    ...base,
    task: { id: "C3", agent: "coder", objective: "sin skills" },
  })
  assert.ok(!without.includes("## Skills a aplicar"), "sin skills declaradas no hay sección")
})

test("detección de Engram: conectado, no disponible y ausente", async () => {
  const missing = makeCtx()
  assert.equal((await detectEngram(missing)).state, "missing")

  const connected = makeCtx()
  connected.mcp.list = async () => ({
    data: [{ name: "engram", status: { status: "connected" } }],
  })
  assert.equal((await detectEngram(connected)).state, "connected")

  const unavailable = makeCtx()
  unavailable.mcp.list = async () => ({
    data: [{ name: "engram", status: { status: "failed", error: "boom" } }],
  })
  assert.equal((await detectEngram(unavailable)).state, "unavailable")

  const pending = makeCtx()
  pending.mcp.list = async () => ({
    data: [{ name: "engram", status: { status: "pending" } }],
  })
  assert.equal((await detectEngram(pending)).state, "unavailable")
})

test("runner: oleadas, paralelismo, parentID y fallos en cadena", async () => {
  const ctx = makeCtx({ delayMs: 100 })
  const updates: number[] = []
  const result = await runOrchestration({
    ctx,
    runId: "RUN-SMOKE-1",
    input: {
      objective: "objetivo",
      tasks: [
        { id: "T1", agent: "explorador", objective: "explorar" },
        { id: "T2", agent: "contexto", objective: "contexto" },
        { id: "T3", agent: "coder", objective: "implementar", dependsOn: ["T1", "T2"] },
      ],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
    parentSessionID: "ses_parent",
    onUpdate: ({ results }) => {
      updates.push(results.length)
    },
  })

  assert.equal(result.results.length, 3)
  assert.ok(result.results.every((entry) => entry.status === "succeeded"))
  assert.equal(result.results[2]!.summary, "resumen de T3")
  assert.ok(updates.length >= 2, `se esperaban actualizaciones de progreso, hubo ${updates.length}`)
  assert.equal(updates.at(-1), 3)

  const created = (ctx as any).__created as any[]
  assert.ok(created.length === 3)
  assert.ok(created.every((input) => input.parentID === "ses_parent"), "las sesiones hijas deben declarar parentID")

  const parallel = makeCtx({ delayMs: 300 })
  const started = Date.now()
  await runOrchestration({
    ctx: parallel,
    runId: "RUN-SMOKE-2",
    input: {
      objective: "paralelo",
      tasks: [
        { id: "P1", agent: "explorador", objective: "a" },
        { id: "P2", agent: "explorador", objective: "b" },
      ],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
  })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 550, `esperado ejecución paralela, tardó ${elapsed}ms`)

  const failing = makeCtx({ fail: ["F1"] })
  const failedRun = await runOrchestration({
    ctx: failing,
    runId: "RUN-SMOKE-3",
    input: {
      objective: "falla",
      tasks: [
        { id: "F1", agent: "coder", objective: "falla" },
        { id: "F2", agent: "qa", objective: "depende", dependsOn: ["F1"] },
      ],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
  })
  assert.equal(failedRun.results[0]!.status, "failed")
  assert.equal(failedRun.results[1]!.status, "skipped")

  const errorCtx = makeCtx()
  errorCtx.session.wait = async () => {
    throw new Error("fallo simulado")
  }
  const errorRun = await runOrchestration({
    ctx: errorCtx,
    runId: "RUN-SMOKE-4",
    input: {
      objective: "error",
      tasks: [
        { id: "E1", agent: "coder", objective: "x" },
        { id: "E2", agent: "qa", objective: "y", dependsOn: ["E1"] },
      ],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
  })
  assert.equal(errorRun.results[0]!.status, "failed")
  assert.equal(errorRun.results[1]!.status, "skipped")
})

test("worktrees: create por tarea, sesión aislada, upstream y limpieza", async () => {
  const ctx = makeCtx({ delayMs: 10 })
  const run = await runOrchestration({
    ctx,
    runId: "RUN-SMOKE-5",
    input: {
      objective: "worktrees",
      tasks: [
        { id: "W1", agent: "coder", objective: "a", worktree: true },
        { id: "W2", agent: "qa", objective: "b", dependsOn: ["W1"] },
      ],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
    projectID: "proj_test",
    worktreeParent: "C:/worktrees",
    cleanupWorktrees: true,
  })

  assert.equal(run.results.length, 2)
  assert.ok(run.results.every((entry) => entry.status === "succeeded"))

  const wt = (ctx as any).__worktrees as { created: any[]; removed: any[] }
  assert.equal(wt.created.length, 1)
  assert.equal(wt.created[0].projectID, "proj_test")
  assert.equal(wt.created[0].branch, "dev")
  assert.equal(wt.created[0].directory, "C:/worktrees")

  const worktreeDir = `C:/worktrees/${wt.created[0].name}`
  assert.equal(run.results[0]!.worktreeDirectory, worktreeDir)

  const sessions = (ctx as any).__created as any[]
  const w1Session = sessions.find((session) => session.metadata?.taskId === "W1")
  assert.equal(w1Session.location.directory, worktreeDir)

  const w2Session = sessions.find((session) => session.metadata?.taskId === "W2")
  assert.equal(w2Session.location, undefined)

  const prompts = (ctx as any).__prompts as Array<{ taskId: string; text: string }>
  const w2Prompt = prompts.find((entry) => entry.taskId === "W2")!
  assert.ok(w2Prompt.text.includes(worktreeDir), "el dependiente debe recibir el worktree upstream")

  assert.equal(wt.removed.length, 1)
  assert.equal(wt.removed[0].directory, worktreeDir)
  assert.equal(wt.removed[0].force, false)
})

test("worktrees: la tarea fallida conserva su worktree", async () => {
  const ctx = makeCtx({ fail: ["F1"] })
  const run = await runOrchestration({
    ctx,
    runId: "RUN-SMOKE-6",
    input: {
      objective: "fallo con worktree",
      tasks: [{ id: "F1", agent: "coder", objective: "x", worktree: true }],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
    projectID: "proj_test",
    worktreeParent: "C:/worktrees",
    cleanupWorktrees: true,
  })

  assert.equal(run.results[0]!.status, "failed")
  const wt = (ctx as any).__worktrees as { created: any[]; removed: any[] }
  assert.equal(wt.created.length, 1)
  assert.equal(wt.removed.length, 0, "un worktree de tarea fallida no debe eliminarse")
})

test("abort: las tareas pendientes se omiten al cancelar el run", async () => {
  const ctx = makeCtx({ delayMs: 10 })
  const control = { aborted: false, sessions: new Set<string>() }
  const run = await runOrchestration({
    ctx,
    runId: "RUN-SMOKE-7",
    input: {
      objective: "abort",
      tasks: [
        { id: "A1", agent: "explorador", objective: "a" },
        { id: "A2", agent: "qa", objective: "b", dependsOn: ["A1"] },
      ],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
    control,
    onUpdate: () => {
      control.aborted = true
    },
  })

  assert.equal(run.results[0]!.status, "succeeded")
  assert.equal(run.results[1]!.status, "skipped")
  assert.ok(String(run.results[1]!.error).includes("abortado"))
})

test("gates: acciones sensibles pasan por permission.assert", async () => {
  const ctx = makeCtx()
  const run = await runOrchestration({
    ctx,
    runId: "RUN-SMOKE-8",
    input: {
      objective: "gate",
      tasks: [
        { id: "G1", agent: "deployer", objective: "push", permissions: { push_to_remote: true } },
      ],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
    parentSessionID: "ses_parent",
  })

  assert.equal(run.results[0]!.status, "succeeded")
  assert.equal(run.results[0]!.gated, true)
  const asserts = (ctx as any).__permissions as any[]
  assert.equal(asserts.length, 1)
  assert.equal(asserts[0].sessionID, "ses_parent")
  assert.equal(asserts[0].action, "deploy")
  assert.ok(asserts[0].resources.includes("G1"))
})

test("gates: un gate denegado falla la tarea sin crear sesión", async () => {
  const ctx = makeCtx()
  ctx.permission.assert = async () => {
    throw new Error("denegado por el humano")
  }

  const run = await runOrchestration({
    ctx,
    runId: "RUN-SMOKE-9",
    input: {
      objective: "gate denegado",
      tasks: [
        { id: "G2", agent: "deployer", objective: "x", permissions: { create_pull_request: true } },
      ],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
    parentSessionID: "ses_parent",
  })

  assert.equal(run.results[0]!.status, "failed")
  assert.ok(String(run.results[0]!.error).includes("Permiso denegado"))
  const created = (ctx as any).__created as any[]
  assert.equal(created.length, 0)
})

test("runId: el runner usa el ID canónico del llamador", async () => {
  const ctx = makeCtx()
  const run = await runOrchestration({
    ctx,
    runId: "RUN-CANON",
    input: { objective: "id", tasks: [{ id: "R1", agent: "explorador", objective: "x" }] },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
  })
  assert.equal(run.runId, "RUN-CANON")
})

test("sin reporte JSON → unconfirmed (no éxito)", async () => {
  const ctx = makeCtx({ noReport: ["N1"] })
  const run = await runOrchestration({
    ctx,
    runId: "RUN-NOREPORT",
    input: { objective: "noreport", tasks: [{ id: "N1", agent: "contexto", objective: "x" }] },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
  })
  assert.equal(run.results[0]!.status, "unconfirmed")
})

test("extractReport: toma el último bloque JSON (el reporte, no el contrato)", () => {
  const text = [
    "## Contrato de entrada",
    "```json",
    '{"task_id":"T","target_agent":"coder"}',
    "```",
    "## Reporte",
    "```json",
    '{"task_id":"T","status":"success","summary":"ok"}',
    "```",
  ].join("\n")

  const report = extractReport(text) as any
  assert.equal(report.status, "success")
  assert.equal(report.summary, "ok")
})

test("worktreeName trunca nombres largos (Windows)", async () => {
  const ctx = makeCtx()
  await runOrchestration({
    ctx,
    runId: "R".repeat(80),
    input: {
      objective: "x",
      tasks: [{ id: "T".repeat(120), agent: "coder", objective: "x", worktree: true }],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
    projectID: "proj_test",
    worktreeParent: "C:/worktrees",
  })

  const created = (ctx as any).__worktrees.created as any[]
  assert.equal(created.length, 1)
  assert.ok(created[0].name.length <= 60, `nombre demasiado largo: ${created[0].name.length}`)
})

test("permisos: git_commit, strict_scope y globs", () => {
  const rules = buildSessionPermissions(
    {
      id: "P1",
      agent: "coder",
      objective: "x",
      strict_scope: true,
      permissions: { git_commit: false },
      scope: { allowed_files: ["src/**"] },
    },
    "C:/repo",
  )

  assert.ok(rules.some((rule) => rule.action === "bash" && rule.resource === "git commit*" && rule.effect === "deny"))
  assert.ok(rules.some((rule) => rule.action === "edit" && rule.resource === "src/**" && rule.effect === "allow"))
  assert.ok(!rules.some((rule) => rule.resource === "C:/repo/src/**"), "los globs no deben duplicarse como ruta absoluta")
  assert.ok(
    rules.some((rule) => rule.action === "bash" && rule.resource === "*" && rule.effect === "deny"),
    "strict_scope sin bash habilitado debe denegar shell",
  )
})

function makeToolCtx(options: { fail?: string[]; delayMs?: number; noReport?: string[] } = {}) {
  const ctx = makeCtx(options)
  const tools = new Map<string, any>()
  ctx.tool.transform = async (callback: any) => {
    callback({
      namespace() {},
      add(definition: any) {
        tools.set(definition.name, definition)
      },
    })
    return { dispose: async () => {} }
  }
  return { ctx, tools }
}

const TOOL_SETTINGS = {
  baseBranch: "dev",
  cleanupSessions: false,
  cleanupWorktrees: false,
  runHistory: 50,
  planDocs: false as string | false,
  workdir: "C:/repo",
}

async function waitForRun(ctx: PluginCtx, runId: string, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const record = await getRun(ctx, runId)
    if (record && record.status !== "running") return record
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`el run ${runId} no terminó a tiempo`)
}

test("tools: orchestrate valida agentes, plan y runId duplicado", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, TOOL_SETTINGS)
  const orchestrate = tools.get("orchestrate")!

  const unknown = await orchestrate.execute(
    { objective: "x", tasks: [{ id: "A", agent: "nope", objective: "x" }] },
    { sessionID: "ses_orq" },
  )
  assert.match(String(unknown.content), /Faltan agentes/)

  const invalid = await orchestrate.execute(
    {
      objective: "x",
      tasks: [
        { id: "A", agent: "contexto", objective: "x" },
        { id: "A", agent: "qa", objective: "y" },
      ],
    },
    { sessionID: "ses_orq" },
  )
  assert.match(String(invalid.content), /plan tiene errores/)

  await saveRun(ctx, {
    runId: "RUN-DUP",
    objective: "x",
    baseBranch: "dev",
    startedAt: new Date().toISOString(),
    status: "completed",
    totalTasks: 0,
    results: [],
  })
  const duplicate = await orchestrate.execute(
    { objective: "x", runId: "RUN-DUP", tasks: [{ id: "A", agent: "contexto", objective: "x" }] },
    { sessionID: "ses_orq" },
  )
  assert.match(String(duplicate.content), /Ya existe un run/)
})

test("tools: orchestrate en segundo plano y run_status lo encuentra", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, TOOL_SETTINGS)
  const orchestrate = tools.get("orchestrate")!
  const runStatus = tools.get("run_status")!

  const started = await orchestrate.execute(
    { objective: "bg", runId: "RUN-TOOL-1", tasks: [{ id: "T1", agent: "contexto", objective: "x" }] },
    { sessionID: "ses_orq" },
  )
  assert.match(String(started.content), /RUN-TOOL-1/)
  assert.equal(started.metadata.status, "running")

  const record = await waitForRun(ctx, "RUN-TOOL-1")
  assert.equal(record.status, "completed")
  assert.equal(record.runId, "RUN-TOOL-1")

  const status = await runStatus.execute({ runId: "RUN-TOOL-1" })
  assert.match(String(status.content), /RUN-TOOL-1/)
  assert.match(String(status.content), /T1/)

  const missing = await runStatus.execute({ runId: "RUN-NOPE" })
  assert.match(String(missing.content), /No existe/)
})

test("tools: run_abort interrumpe un run activo y lo marca aborted", async () => {
  const { ctx, tools } = makeToolCtx({ delayMs: 150 })
  await registerTools(ctx, TOOL_SETTINGS)
  const orchestrate = tools.get("orchestrate")!
  const abort = tools.get("run_abort")!

  await orchestrate.execute(
    { objective: "abort", runId: "RUN-TOOL-2", tasks: [{ id: "A1", agent: "contexto", objective: "x" }] },
    { sessionID: "ses_orq" },
  )

  const response = await abort.execute({ runId: "RUN-TOOL-2" })
  assert.match(String(response.content), /Abort solicitado/)

  const record = await waitForRun(ctx, "RUN-TOOL-2")
  assert.equal(record.status, "aborted")

  const missing = await abort.execute({ runId: "RUN-NOPE-2" })
  assert.match(String(missing.content), /No existe/)
})

test("tools: fallo de storage inicial impide arrancar el run", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, TOOL_SETTINGS)
  const orchestrate = tools.get("orchestrate")!

  const originalSet = ctx.storage.set.bind(ctx.storage)
  let calls = 0
  ctx.storage.set = async (key: string, value: any) => {
    calls++
    if (calls === 1) throw new Error("storage caído")
    return originalSet(key, value)
  }

  const response = await orchestrate.execute(
    { objective: "x", runId: "RUN-TOOL-3", tasks: [{ id: "T1", agent: "contexto", objective: "x" }] },
    { sessionID: "ses_orq" },
  )
  assert.match(String(response.content), /No se pudo inicializar el run/)
})

test("tools: fallo al listar agentes no finge que faltan", async () => {
  const { ctx, tools } = makeToolCtx()
  ctx.agent.list = async () => {
    throw new Error("boom")
  }
  await registerTools(ctx, TOOL_SETTINGS)
  const orchestrate = tools.get("orchestrate")!

  const response = await orchestrate.execute(
    { objective: "x", tasks: [{ id: "A", agent: "contexto", objective: "x" }] },
    { sessionID: "ses_orq" },
  )
  assert.match(String(response.content), /No se pudo listar los agentes/)
})

test("tools: engram_status reporta ausencia con guía", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, TOOL_SETTINGS)
  const engram = tools.get("engram_status")!

  const response = await engram.execute({})
  assert.match(String(response.content), /NO está registrado/)
})

test("tools: run_status muestra las tareas en curso", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, TOOL_SETTINGS)
  const runStatus = tools.get("run_status")!

  await saveRun(ctx, {
    runId: "RUN-INFLIGHT",
    objective: "x",
    baseBranch: "dev",
    startedAt: new Date().toISOString(),
    status: "running",
    totalTasks: 2,
    inFlight: ["T1", "T2"],
    results: [],
  })

  const response = await runStatus.execute({ runId: "RUN-INFLIGHT" })
  assert.match(String(response.content), /En curso/)
  assert.match(String(response.content), /T1/)
})

test("historial: guardar, recuperar y listar runs", async () => {
  const ctx = makeCtx()
  const record = {
    runId: "RUN-1",
    objective: "objetivo",
    baseBranch: "dev",
    startedAt: new Date().toISOString(),
    status: "running" as const,
    totalTasks: 1,
    results: [],
  }

  await saveRun(ctx, record)
  const fetched = await getRun(ctx, "RUN-1")
  assert.equal(fetched?.runId, "RUN-1")
  assert.equal(fetched?.status, "running")

  const list = await recentRuns(ctx)
  assert.equal(list.length, 1)
})

test("historial: pruneRuns conserva los más recientes", async () => {
  const ctx = makeCtx()
  for (let i = 0; i < 5; i++) {
    await saveRun(ctx, {
      runId: `RUN-PRUNE-${i}`,
      objective: "x",
      baseBranch: "dev",
      startedAt: new Date(Date.now() + i * 1000).toISOString(),
      status: "completed",
      totalTasks: 0,
      results: [],
    })
  }

  const removed = await pruneRuns(ctx, 2)
  assert.equal(removed, 3, "debe eliminar los 3 más antiguos")

  const remaining = await recentRuns(ctx, 10)
  assert.equal(remaining.length, 2)
  assert.equal(remaining[0]!.runId, "RUN-PRUNE-4")
  assert.equal(remaining[1]!.runId, "RUN-PRUNE-3")

  const gone = await getRun(ctx, "RUN-PRUNE-0")
  assert.equal(gone, undefined)
})

test("historial: pruneRuns sin argumento usa default 50", async () => {
  const ctx = makeCtx()
  for (let i = 0; i < 10; i++) {
    await saveRun(ctx, {
      runId: `RUN-DEFAULT-${i}`,
      objective: "x",
      baseBranch: "dev",
      startedAt: new Date(Date.now() + i * 1000).toISOString(),
      status: "completed",
      totalTasks: 0,
      results: [],
    })
  }

  const removed = await pruneRuns(ctx)
  assert.equal(removed, 0, "con menos de 50 runs no debe eliminar nada")

  const remaining = await recentRuns(ctx, 100)
  assert.equal(remaining.length, 10)
})

test("tools: runHistory se conecta de extremo a extremo", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, { ...TOOL_SETTINGS, runHistory: 2 })
  const orchestrate = tools.get("orchestrate")!

  for (let i = 0; i < 3; i++) {
    const started = await orchestrate.execute(
      {
        objective: `run ${i}`,
        runId: `RUN-E2E-${i}`,
        tasks: [{ id: `E${i}`, agent: "contexto", objective: "x" }],
      },
      { sessionID: "ses_orq" },
    )
    assert.equal(started.metadata.status, "running")
  }

  // El run más antiguo se poda en cuanto termina (runHistory=2), así que no se
  // puede esperar su registro: se espera a que el historial quede estable.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const snapshot = await recentRuns(ctx, 10)
    if (snapshot.length === 2 && snapshot.every((run) => run.status !== "running")) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  const runs = await recentRuns(ctx, 10)
  assert.equal(runs.length, 2, "con runHistory=2 deben quedar los dos runs más recientes")
  assert.equal(runs[0]!.runId, "RUN-E2E-2")
  assert.equal(runs[1]!.runId, "RUN-E2E-1")
})

test("skills: registra las 16 skills del catálogo .agents/skills/", async () => {
  const ctx = makeCtx()
  const added: any[] = []
  ;(ctx as any).skill = {
    async transform(callback: any) {
      const editor = { add: (skill: any) => added.push(skill) }
      callback(editor)
      return { dispose: async () => {} }
    },
  }

  await registerSkills(ctx, { workdir: process.cwd() })

  const ids = added.map((skill) => skill.id).sort()
  assert.deepEqual(ids, [
    "code-review",
    "codebase-design",
    "diagnosing-bugs",
    "domain-modeling",
    "grill-me",
    "grill-with-docs",
    "grilling",
    "implement-spec",
    "research",
    "retro",
    "setup-matt-pocock-skills",
    "tdd",
    "to-spec",
    "to-tickets",
    "triage",
    "writing-for-agents",
  ])

  const grilling = added.find((skill) => skill.id === "grilling")
  const grillMe = added.find((skill) => skill.id === "grill-me")

  assert.ok(grilling, "debe existir la skill grilling")
  assert.ok(grillMe, "debe existir la skill grill-me")

  assert.ok(grilling.content.includes("design tree"), "el contenido de grilling debe incluir su cuerpo markdown")
  assert.equal(grilling.autoinvoke, undefined, "grilling es autoinvocable por defecto")
  // Regresión de err_415a4c0e: el esquema de OpenCode (clave opcional de Effect
  // Schema) rechaza claves presentes con valor undefined ("Expected boolean"),
  // lo que deshabilita el plugin entero. La clave debe omitirse, no ir vacía.
  assert.ok(!("autoinvoke" in grilling), "grilling no debe llevar la clave autoinvoke (presente-undefined rompe el esquema)")
  assert.equal(grillMe.autoinvoke, false, "grill-me debe deshabilitar la autoinvocación")
  assert.ok("autoinvoke" in grillMe, "grill-me sí debe llevar autoinvoke:false explícito")
  for (const skill of added) {
    for (const [key, value] of Object.entries(skill)) {
      assert.ok(value !== undefined, `la skill ${skill.id} no debe tener la clave ${key} con valor undefined`)
    }
  }
  assert.equal(grillMe.path, path.join(process.cwd(), ".agents", "skills", "grill-me", "SKILL.md"))

  const grillWithDocs = added.find((skill) => skill.id === "grill-with-docs")!
  assert.equal(grillWithDocs.autoinvoke, false, "grill-with-docs declara disable-model-invocation:true")

  // Cadena de workflow de Matt Pocock: grill-with-docs -> to-spec -> to-tickets
  // -> implement-spec -> retro, más el setup, son puntos de control manual.
  // writing-for-agents es un documento de referencia autoinvocable.
  const explicitSkills = [
    "grill-me",
    "grill-with-docs",
    "to-spec",
    "to-tickets",
    "implement-spec",
    "retro",
    "triage",
    "setup-matt-pocock-skills",
  ]
  assert.deepEqual(
    added
      .filter((skill) => skill.autoinvoke === false)
      .map((skill) => skill.id)
      .sort(),
    [...explicitSkills].sort(),
    "solo esas skills están restringidas a invocación explícita",
  )
  const writingForAgents = added.find((skill) => skill.id === "writing-for-agents")!
  assert.ok(!("autoinvoke" in writingForAgents), "writing-for-agents no declara disable-model-invocation")
  assert.ok(
    writingForAgents.content.includes("SKILL-MECHANICS.md"),
    "writing-for-agents referencia su documento de soporte",
  )
  assert.ok(
    added.every((skill) => typeof skill.content === "string" && skill.content.length > 0),
    "toda skill debe llevar el cuerpo markdown del SKILL.md",
  )

  // Vendor de mattpocock/skills: los documentos de soporte viajan en el mismo
  // directorio porque el cuerpo del SKILL.md los referencia con ruta relativa.
  for (const supportFile of ["SKILL.md", "mocking.md", "tests.md", "agents/openai.yaml"]) {
    assert.equal(
      fs.existsSync(path.join(process.cwd(), ".agents", "skills", "tdd", supportFile)),
      true,
      `tdd debe conservar ${supportFile}`,
    )
  }

  // El setup y writing-for-agents no tienen cuerpo propio suficiente: sus
  // documentos de soporte son parte del contrato (tracker, triage, mecánica).
  const supportBySkill: Record<string, string[]> = {
    "setup-matt-pocock-skills": [
      "domain.md",
      "issue-tracker-github.md",
      "issue-tracker-gitlab.md",
      "issue-tracker-local.md",
      "triage-labels.md",
    ],
    "writing-for-agents": ["SKILL-MECHANICS.md"],
    triage: ["AGENT-BRIEF.md", "OUT-OF-SCOPE.md"],
  }
  for (const [skillId, files] of Object.entries(supportBySkill)) {
    for (const supportFile of files) {
      assert.equal(
        fs.existsSync(path.join(process.cwd(), ".agents", "skills", skillId, supportFile)),
        true,
        `${skillId} debe conservar ${supportFile}`,
      )
    }
  }

  const notices = fs.readFileSync(path.join(process.cwd(), ".agents", "skills", "THIRD-PARTY-NOTICES.md"), "utf8")
  assert.match(notices, /MIT License/)
  assert.match(notices, /Copyright \(c\) 2026 Matt Pocock/)
  assert.match(notices, /4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/, "el aviso debe fijar el commit vendorizado")
})

test("skills: option skills:false no registra nada", async () => {
  const ctx = makeCtx()
  let called = false
  ;(ctx as any).skill = {
    async transform() {
      called = true
      return { dispose: async () => {} }
    },
  }

  await registerSkills(ctx, { enabled: false, workdir: process.cwd() })
  assert.equal(called, false, "no debe llamar a ctx.skill.transform cuando skills:false")
})

test("skills: degradación graceful cuando ctx.skill no existe", async () => {
  const commands: any[] = []
  const tools: any[] = []
  const warnings: string[] = []

  const ctx = makeCtx()
  // Puerto 0: la prueba no debe abrir el dashboard real en 4780.
  ctx.options = { dashboardPort: 0 }
  ctx.command.transform = async (callback: any) => {
    callback({ add: (command: any) => commands.push(command) })
    return { dispose: async () => {} }
  }
  ctx.tool.transform = async (callback: any) => {
    callback({
      namespace() {},
      add: (tool: any) => tools.push(tool),
    })
    return { dispose: async () => {} }
  }

  const originalWarn = console.warn
  console.warn = (...args: any[]) => {
    warnings.push(args.join(" "))
  }

  let dispose: unknown
  try {
    const setup = (plugin as { setup: (context: PluginCtx) => Promise<() => Promise<void>> }).setup
    dispose = await setup(ctx)
  } finally {
    console.warn = originalWarn
  }

  assert.equal(typeof dispose, "function", "el setup debe completarse y devolver cleanup")
  assert.ok(commands.length >= 2, "debe registrar los comandos del plugin")
  assert.ok(tools.length >= 1, "debe registrar las tools del plugin")
  assert.ok(
    warnings.some((warning) => warning.includes("ctx.skill.transform no está disponible")),
    "debe advertir la degradación cuando ctx.skill falta",
  )
  await (dispose as () => Promise<void>)()
})

async function waitForFile(filePath: string, timeoutMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`no apareció ${filePath}`)
}

function cleanupDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

test("plandocs: renderiza markdown con frontmatter, tabla y estados", () => {
  const markdown = renderPlanMarkdown({
    workdir: "C:/repo",
    folder: "docs/plans",
    runId: "RUN-PLAN-1",
    objective: "objetivo de prueba",
    baseBranch: "dev",
    startedAt: "2024-01-01T00:00:00.000Z",
    status: "running",
    contextSummary: "contexto del run",
    tasks: [
      { id: "T1", agent: "explorador", objective: "a" },
      { id: "T2", agent: "coder", objective: "b", dependsOn: ["T1"], branch: "feat/T2" },
    ],
    results: [{ taskId: "T1", agent: "explorador", status: "succeeded", summary: "resumen T1" }],
    inFlight: [toInFlightTask({ taskId: "T2", agent: "coder" })],
  })

  assert.match(markdown, /runId: "RUN-PLAN-1"/)
  assert.match(markdown, /objective: objetivo de prueba/)
  assert.match(markdown, /status: running/)
  assert.match(markdown, /baseBranch: dev/)
  assert.match(markdown, /startedAt: "2024-01-01T00:00:00.000Z"/)
  assert.match(markdown, /## Contexto/)
  assert.match(markdown, /contexto del run/)
  assert.match(markdown, /\| T1 \| explorador \| ✅ succeeded \|/)
  assert.match(markdown, /\| T2 \| coder \| ⏳ running \| `feat\/T2` \| T1 \|/)
  assert.match(markdown, /## Avance por tarea/)
  assert.match(markdown, /\*\*T1\*\* \(✅ succeeded\): resumen T1/)
  assert.match(markdown, /\*\*T2\*\* \(⏳ running\): \(sin resumen\)/)
})

test("plandocs: sanitización de carpeta", () => {
  assert.equal(sanitizePlanDocsFolder("docs/planes"), "docs/planes")
  assert.equal(sanitizePlanDocsFolder("  docs/planes  "), "docs/planes")
  assert.equal(sanitizePlanDocsFolder("docs/planes/sub"), "docs/planes/sub")
  assert.equal(sanitizePlanDocsFolder("docs\\\\planes"), "docs/planes")
  assert.equal(sanitizePlanDocsFolder("C:/abs"), "docs/plans")
  assert.equal(sanitizePlanDocsFolder("/abs"), "docs/plans")
  assert.equal(sanitizePlanDocsFolder("docs/../plans"), "docs/plans")
  assert.equal(sanitizePlanDocsFolder(""), "docs/plans")
  assert.equal(sanitizePlanDocsFolder("   "), "docs/plans")
  assert.equal(sanitizePlanDocsFolder("./docs/plans"), "docs/plans")
})

test("plandocs: writePlanDocs propaga errores para fail-hard inicial", async () => {
  const failingWriter = {
    mkdir: async () => {},
    writeFile: async () => {
      throw new Error("disk full")
    },
  }
  await assert.rejects(
    writePlanDocs(
      {
        workdir: "C:/repo",
        folder: "docs/plans",
        runId: "RUN-FAIL-UNIT",
        objective: "x",
        baseBranch: "dev",
        startedAt: new Date().toISOString(),
        status: "running",
        tasks: [{ id: "T1", agent: "contexto", objective: "x" }],
        results: [],
        inFlight: [],
      },
      failingWriter,
    ),
    /disk full/,
  )
})

test("plandocs: activado escribe el spec inicial y run_status lo muestra", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plandocs-status-"))
  try {
    const { ctx, tools } = makeToolCtx()
    await registerTools(ctx, { ...TOOL_SETTINGS, workdir: tmpDir, planDocs: "docs/plans" })
    const orchestrate = tools.get("orchestrate")!
    const runStatus = tools.get("run_status")!

    await orchestrate.execute(
      {
        objective: "objetivo con plan",
        runId: "RUN-PLAN-STATUS",
        tasks: [{ id: "T1", agent: "contexto", objective: "x" }],
        context: { summary: "contexto de la orquestación" },
      },
      { sessionID: "ses_orq" },
    )
    await waitForRun(ctx, "RUN-PLAN-STATUS")

    const planPath = path.join(tmpDir, "docs/plans/RUN-PLAN-STATUS.md")
    assert.equal(fs.existsSync(planPath), true)
    const content = fs.readFileSync(planPath, "utf8")
    assert.match(content, /runId: "RUN-PLAN-STATUS"/)
    assert.match(content, /contexto de la orquestación/)
    assert.match(content, /\| T1 \| contexto \| ✅ succeeded \|/)

    const status = await runStatus.execute({ runId: "RUN-PLAN-STATUS" })
    assert.match(String(status.content), /\*\*Plan:\*\* docs\/plans\/RUN-PLAN-STATUS\.md/)
  } finally {
    cleanupDir(tmpDir)
  }
})

test("plandocs: carpeta custom se refleja en run_status", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plandocs-custom-"))
  try {
    const { ctx, tools } = makeToolCtx()
    await registerTools(ctx, { ...TOOL_SETTINGS, workdir: tmpDir, planDocs: "custom/planes" })
    const orchestrate = tools.get("orchestrate")!
    const runStatus = tools.get("run_status")!

    await orchestrate.execute(
      { objective: "x", runId: "RUN-CUSTOM", tasks: [{ id: "T1", agent: "contexto", objective: "x" }] },
      { sessionID: "ses_orq" },
    )
    await waitForRun(ctx, "RUN-CUSTOM")

    assert.equal(fs.existsSync(path.join(tmpDir, "custom/planes/RUN-CUSTOM.md")), true)
    const status = await runStatus.execute({ runId: "RUN-CUSTOM" })
    assert.match(String(status.content), /\*\*Plan:\*\* custom\/planes\/RUN-CUSTOM\.md/)
  } finally {
    cleanupDir(tmpDir)
  }
})

test("plandocs: fallo inicial aborta el run sin crear sesiones", async () => {
  const { ctx, tools } = makeToolCtx()
  const badWorkdir = path.join(os.tmpdir(), "plandocs-fail-*invalid*")
  await registerTools(ctx, { ...TOOL_SETTINGS, workdir: badWorkdir, planDocs: "docs/plans" })
  const orchestrate = tools.get("orchestrate")!

  const response = await orchestrate.execute(
    { objective: "x", runId: "RUN-PLAN-FAIL", tasks: [{ id: "T1", agent: "contexto", objective: "x" }] },
    { sessionID: "ses_orq" },
  )
  assert.match(String(response.content), /No se pudo inicializar el plan de documentación/)
  assert.equal(response.metadata.ok, false)

  const created = (ctx as any).__created as any[]
  assert.equal(created.length, 0, "no debe crear sesiones si falla el plan inicial")
})

test("plandocs: fallo en update no rompe el run", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plandocs-be-"))
  try {
    const { ctx, tools } = makeToolCtx({ delayMs: 300 })
    await registerTools(ctx, { ...TOOL_SETTINGS, workdir: tmpDir, planDocs: "docs/plans" })
    const orchestrate = tools.get("orchestrate")!

    orchestrate.execute(
      { objective: "x", runId: "RUN-BE", tasks: [{ id: "T1", agent: "contexto", objective: "x" }] },
      { sessionID: "ses_orq" },
    )

    const planPath = path.join(tmpDir, "docs/plans/RUN-BE.md")
    await waitForFile(planPath, 1000)
    fs.chmodSync(planPath, 0o444)

    const record = await waitForRun(ctx, "RUN-BE")
    assert.equal(record.status, "completed", "el run debe terminar a pesar del fallo de escritura")
  } finally {
    cleanupDir(tmpDir)
  }
})

test("plandocs: fallo en update acumula warning y run_status lo muestra", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plandocs-warning-"))
  try {
    const { ctx, tools } = makeToolCtx({ delayMs: 300 })
    await registerTools(ctx, { ...TOOL_SETTINGS, workdir: tmpDir, planDocs: "docs/plans" })
    const orchestrate = tools.get("orchestrate")!
    const runStatus = tools.get("run_status")!

    orchestrate.execute(
      { objective: "x", runId: "RUN-WARNING", tasks: [{ id: "T1", agent: "contexto", objective: "x" }] },
      { sessionID: "ses_orq" },
    )

    const planPath = path.join(tmpDir, "docs/plans/RUN-WARNING.md")
    await waitForFile(planPath, 1000)
    fs.chmodSync(planPath, 0o444)

    const record = await waitForRun(ctx, "RUN-WARNING")
    assert.equal(record.status, "completed", "el run debe terminar a pesar del fallo de escritura")
    assert.ok(record.planDocWarnings && record.planDocWarnings.length > 0, "debe acumular al menos una advertencia")
    assert.match(record.planDocWarnings![0]!, /No se pudo actualizar/)

    const status = await runStatus.execute({ runId: "RUN-WARNING" })
    assert.match(String(status.content), /Advertencias del documento de plan/)
    assert.match(String(status.content), /No se pudo actualizar/)
  } finally {
    cleanupDir(tmpDir)
  }
})

test("plandocs: abort marca el plan como aborted", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plandocs-abort-"))
  try {
    const { ctx, tools } = makeToolCtx({ delayMs: 500 })
    await registerTools(ctx, { ...TOOL_SETTINGS, workdir: tmpDir, planDocs: "docs/plans" })
    const orchestrate = tools.get("orchestrate")!
    const abort = tools.get("run_abort")!

    orchestrate.execute(
      { objective: "abort", runId: "RUN-PLAN-ABORT", tasks: [{ id: "A1", agent: "contexto", objective: "x" }] },
      { sessionID: "ses_orq" },
    )

    const planPath = path.join(tmpDir, "docs/plans/RUN-PLAN-ABORT.md")
    await waitForFile(planPath, 1000)
    await abort.execute({ runId: "RUN-PLAN-ABORT" })

    const record = await waitForRun(ctx, "RUN-PLAN-ABORT")
    assert.equal(record.status, "aborted")

    const content = fs.readFileSync(planPath, "utf8")
    assert.match(content, /status: aborted/)
  } finally {
    cleanupDir(tmpDir)
  }
})

test("plandocs: desactivado no escribe nada", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plandocs-off-"))
  try {
    const { ctx, tools } = makeToolCtx()
    await registerTools(ctx, { ...TOOL_SETTINGS, workdir: tmpDir, planDocs: false })
    const orchestrate = tools.get("orchestrate")!

    await orchestrate.execute(
      { objective: "x", runId: "RUN-OFF", tasks: [{ id: "T1", agent: "contexto", objective: "x" }] },
      { sessionID: "ses_orq" },
    )
    await waitForRun(ctx, "RUN-OFF")

    assert.equal(fs.existsSync(path.join(tmpDir, "docs/plans/RUN-OFF.md")), false)
  } finally {
    cleanupDir(tmpDir)
  }
})

// ---------------------------------------------------------------------------
// Dashboard web local en vivo
// ---------------------------------------------------------------------------

function dashboardRuns(): RunRecord[] {
  return [
    {
      runId: "RUN-LIVE",
      objective: "objetivo <live>",
      baseBranch: "dev",
      startedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
      totalTasks: 3,
      inFlight: ["T3"],
      results: [
        {
          taskId: "T1",
          agent: "coder",
          status: "succeeded",
          branch: "feat/T1",
          latencyMs: 1500,
          tokens: { input: 10, output: 5 },
          cost: 0.0012,
          summary: "ok",
        },
        { taskId: "T2", agent: "qa", status: "failed", latencyMs: 250, error: "boom" },
      ],
    },
    {
      runId: "RUN-OLD",
      objective: "viejo",
      baseBranch: "dev",
      startedAt: "2023-12-31T00:00:00.000Z",
      finishedAt: "2023-12-31T00:00:05.000Z",
      status: "completed",
      totalTasks: 1,
      results: [{ taskId: "T0", agent: "explorador", status: "succeeded", latencyMs: 500 }],
    },
  ]
}

test("dashboard: view-model calcula progreso, historial y filas por tarea", () => {
  const view = buildDashboardView(dashboardRuns(), new Date("2024-01-01T00:00:10.000Z"))

  // La vista y `/api/state` comparten la versión v4 del contrato.
  assert.equal(view.version, DASHBOARD_STATE_VERSION)
  assert.equal(view.active?.runId, "RUN-LIVE")
  assert.equal(view.active?.progressLabel, "2/3")
  assert.equal(view.active?.progressDone, 2)
  assert.equal(view.active?.progressTotal, 3)
  assert.equal(view.active?.duration, "10.0s")
  assert.equal(view.active?.tasks.length, 3, "dos cerradas + la que está en vuelo")

  const done = view.active!.tasks[0]!
  assert.equal(done.status, "succeeded")
  assert.equal(done.glyph, "✅")
  assert.match(done.statusText, /completada/)
  assert.equal(done.time, "1.5s")
  assert.match(done.tokens!, /15/)
  assert.match(done.cost!, /\$0\.0012/)
  assert.equal(done.branch, "feat/T1")

  const failed = view.active!.tasks[1]!
  assert.equal(failed.glyph, "❌")
  assert.match(failed.statusText, /falló/)

  const running = view.active!.tasks[2]!
  assert.equal(running.taskId, "T3")
  assert.equal(running.status, "running")
  assert.equal(running.isRunning, true)
  assert.match(running.statusText, /en curso/)

  assert.equal(view.history.length, 1, "el run activo no se repite en el historial")
  assert.equal(view.history[0]!.runId, "RUN-OLD")
  assert.equal(view.history[0]!.progressLabel, "1/1")
  assert.equal(view.history[0]!.isActive, false)
  assert.equal(view.showTokens, true)
  assert.equal(view.totals.runs, 2)
  assert.equal(view.totals.tasks, 4)
})

test("dashboard: el bloque tokens/costo solo aparece si hay datos", () => {
  const sinTokens: RunRecord[] = [
    {
      runId: "RUN-PLAIN",
      objective: "sin telemetría",
      baseBranch: "dev",
      startedAt: "2024-01-01T00:00:00.000Z",
      status: "completed",
      totalTasks: 1,
      results: [{ taskId: "P1", agent: "contexto", status: "succeeded", latencyMs: 800 }],
    },
  ]

  const view = buildDashboardView(sinTokens)
  assert.equal(view.showTokens, false)
  assert.equal(view.active, null)
  assert.equal(view.history.length, 1)
  assert.equal(view.history[0]!.tasks[0]!.tokens, undefined)
  assert.equal(view.history[0]!.tasks[0]!.cost, undefined)

  const html = renderDashboardHtml(view)
  const markup = html.slice(0, html.indexOf("<script>"))
  assert.ok(!markup.includes('class="node-tokens"'), "sin datos no debe existir el bloque de tokens")
  assert.match(html, /<details class="run-card/, "el historial va plegado en details")

  const conTokens = renderDashboardHtml(buildDashboardView(dashboardRuns()))
  assert.match(
    conTokens.slice(0, conTokens.indexOf("<script>")),
    /class="node-tokens"/,
    "con datos se pinta el bloque de tokens",
  )
})

test("dashboard: el nivel de QA se expone en la vista y como badge discreto", () => {
  const runs = dashboardRuns()
  runs[0]!.results[0]!.qaLevel = "L1"
  runs[0]!.results[1]!.qaLevel = "L3"

  const view = buildDashboardView(runs, new Date("2024-01-01T00:00:10.000Z"))
  assert.equal(view.active!.tasks[0]!.qaLevel, "L1")
  assert.equal(view.active!.tasks[1]!.qaLevel, "L3")
  assert.equal(view.active!.tasks[2]!.qaLevel, undefined, "la tarea en vuelo aún no conoce su nivel")

  const html = renderDashboardHtml(view)
  assert.match(html, /<span class="qa-badge">L1<\/span>/)
  assert.match(html, /<span class="qa-badge">L3<\/span>/)
  assert.match(html, /\.qa-badge \{/, "el badge tiene estilo propio (sin colores nuevos)")

  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"))
  assert.ok(script.includes("qa-badge"), "el refresco del cliente repinta el badge")
  assert.doesNotThrow(() => new Function(script), "el JS embebido sigue siendo válido")
})

test("dashboard: escapeHtml neutraliza HTML y comillas", () => {
  assert.equal(
    escapeHtml('<b class="x">Tom & "Jerry"</b>'),
    "&lt;b class=&quot;x&quot;&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;",
  )
  assert.equal(escapeHtml("O'Brien"), "O&#39;Brien")
  assert.equal(escapeHtml(undefined), "")
})

test("dashboard: la página incluye spinner accesible, polling y texto escapado", () => {
  const runs = dashboardRuns()
  runs[0]!.objective = '<script>alert("x")</script>'
  const html = renderDashboardHtml(buildDashboardView(runs), { refreshMs: DASHBOARD_REFRESH_MS })

  assert.ok(!html.includes('<script>alert("x")</script>'), "el objetivo debe ir escapado")
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/)
  assert.match(html, /class="spinner pulse"/, "la tarea en curso usa la clase pulse")
  assert.match(html, /\.pulse \{ animation: pulse 2s/, "el spinner anima en 2s")
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(html, /REFRESH = 2500/)
  assert.match(html, /setInterval\(refresh, REFRESH\)/)
  assert.match(html, /fetch\("\/api\/state"/)
  assert.match(html, /role="progressbar"/)

  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"))
  assert.ok(script.includes("refresh()"), "el script embebido debe arrancar el polling")
  assert.doesNotThrow(() => new Function(script), "el JS embebido debe ser sintácticamente válido")
})

test("dashboard: normalización de dashboardPort (0 off, inválido a 4780)", () => {
  assert.equal(normalizeDashboardPort(undefined).port, DEFAULT_DASHBOARD_PORT)
  assert.equal(DEFAULT_DASHBOARD_PORT, 4780)
  assert.equal(normalizeDashboardPort(4781).port, 4781)
  assert.equal(normalizeDashboardPort(0).port, 0)
  assert.equal(normalizeDashboardPort(65535).port, 65535)

  for (const invalid of [-1, 1.5, 70000, "4780", true, {}]) {
    const result = normalizeDashboardPort(invalid)
    assert.equal(result.port, DEFAULT_DASHBOARD_PORT, `${String(invalid)} debe caer al default`)
    assert.ok(result.warning, `${String(invalid)} debe advertir del valor inválido`)
    assert.match(result.warning!, /dashboardPort/)
  }
})

test("dashboard: /api/health y /api/state responden desde un puerto efímero", async () => {
  const ctx = makeCtx()
  await saveRun(ctx, {
    runId: "RUN-DASH-1",
    objective: "objetivo del dashboard",
    baseBranch: "dev",
    startedAt: new Date().toISOString(),
    status: "running",
    totalTasks: 1,
    inFlight: ["D1"],
    results: [],
  })

  const handle = await startDashboard(ctx, 0)
  assert.ok(handle, "el dashboard debe arrancar")
  try {
    assert.equal(handle!.host, "127.0.0.1")
    assert.ok(handle!.port > 0)
    assert.equal(handle!.url, `http://127.0.0.1:${handle!.port}`)
    assert.equal(activeDashboard(), handle, "debe ser singleton")

    const sameHandle = await startDashboard(ctx, 0)
    assert.equal(sameHandle, handle, "un segundo arranque reutiliza el servidor vivo")

    const healthResponse = await fetch(`${handle!.url}/api/health`)
    assert.equal(healthResponse.status, 200)
    const health: any = await healthResponse.json()
    assert.equal(health.ok, true)
    assert.equal(health.service, "aiapaec-dashboard")
    assert.equal(health.version, DASHBOARD_STATE_VERSION)
    assert.equal(health.runId, "RUN-DASH-1")

    const stateResponse = await fetch(`${handle!.url}/api/state`)
    assert.equal(stateResponse.status, 200)
    assert.match(stateResponse.headers.get("cache-control") ?? "", /no-store/)
    const state: any = await stateResponse.json()
    assert.equal(state.version, DASHBOARD_STATE_VERSION)
    assert.equal(state.active.runId, "RUN-DASH-1")
    assert.equal(state.active.progressLabel, "0/1")
    assert.equal(state.active.tasks[0].isRunning, true)

    const pageResponse = await fetch(`${handle!.url}/`)
    assert.equal(pageResponse.status, 200)
    assert.match(pageResponse.headers.get("content-type") ?? "", /text\/html/)
    const page = await pageResponse.text()
    assert.match(page, /Aiapaec · árbol de ejecución/)
    assert.match(page, /127\.0\.0\.1/)
    assert.match(page, /id="dash-url"/, "la URL del dashboard va visible en la cabecera")
    assert.ok(page.includes(handle!.url), "la cabecera muestra la URL real del servidor")

    const missing = await fetch(`${handle!.url}/api/nope`)
    assert.equal(missing.status, 404)
  } finally {
    await handle!.close()
  }

  assert.equal(activeDashboard(), undefined, "close() libera el singleton")
})

test("dashboard: puerto ocupado — cede ante instancia viva y desactiva si es ajena", async () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: any[]) => {
    warnings.push(args.join(" "))
  }

  const live = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: true, service: "aiapaec-dashboard", version: 1 }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", () => resolve()))
  const livePort = (live.address() as any).port

  let ceded: Awaited<ReturnType<typeof startDashboard>>
  try {
    ceded = await startDashboard(makeCtx(), livePort)
  } finally {
    await new Promise<void>((resolve) => live.close(() => resolve()))
  }

  assert.equal(ceded, undefined, "con otra instancia viva no se arranca un segundo servidor")
  assert.ok(
    warnings.some((warning) => /instancia viva/.test(warning)),
    "debe avisar que cede el puerto",
  )

  const foreign = createServer((_request, response) => {
    response.writeHead(500)
    response.end("boom")
  })
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", () => resolve()))
  const foreignPort = (foreign.address() as any).port

  let orphan: Awaited<ReturnType<typeof startDashboard>>
  try {
    orphan = await startDashboard(makeCtx(), foreignPort)
  } finally {
    console.warn = originalWarn
    await new Promise<void>((resolve) => foreign.close(() => resolve()))
  }

  assert.equal(orphan, undefined, "si el ocupante no es el dashboard, se reintenta y se desactiva")
  assert.ok(
    warnings.some((warning) => /reintent/i.test(warning)),
    "debe avisar del reintento ante un ocupante ajeno",
  )
  assert.equal(activeDashboard(), undefined)
})

test("dashboard: dashboardPort 0 no inicia el servidor en setup", async () => {
  const ctx = makeCtx()
  ctx.options = { dashboardPort: 0 }
  const setup = (plugin as { setup: (context: PluginCtx) => Promise<() => Promise<void>> }).setup

  const dispose = await setup(ctx)
  try {
    assert.equal(activeDashboard(), undefined, "con dashboardPort 0 no debe abrirse ningún puerto")
  } finally {
    await dispose()
  }
})

test("dashboard: orchestrate y run_status muestran la URL del dashboard", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, {
    ...TOOL_SETTINGS,
    dashboard: { port: DEFAULT_DASHBOARD_PORT, url: `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}` },
  })
  const orchestrate = tools.get("orchestrate")!
  const runStatus = tools.get("run_status")!

  const started = await orchestrate.execute(
    { objective: "dash", runId: "RUN-DASH-TOOL", tasks: [{ id: "D1", agent: "contexto", objective: "x" }] },
    { sessionID: "ses_orq" },
  )
  const expected = `Dashboard: http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`
  assert.ok(String(started.content).includes(expected), "orchestrate anuncia la URL")
  assert.equal(started.metadata.dashboard, `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`)

  await waitForRun(ctx, "RUN-DASH-TOOL")

  const status = await runStatus.execute({ runId: "RUN-DASH-TOOL" })
  assert.ok(String(status.content).includes(expected), "run_status de un run muestra la URL")

  const list = await runStatus.execute({})
  assert.ok(String(list.content).includes(expected), "run_status de la lista muestra la URL")

  const offline = makeToolCtx()
  await registerTools(offline.ctx, TOOL_SETTINGS)
  const response = await offline.tools.get("orchestrate")!.execute(
    { objective: "sin dash", runId: "RUN-NODASH", tasks: [{ id: "N1", agent: "contexto", objective: "x" }] },
    { sessionID: "ses_orq" },
  )
  assert.ok(!String(response.content).includes("Dashboard:"), "sin dashboard no se anuncia URL")
  await waitForRun(offline.ctx, "RUN-NODASH")
})

// ---------------------------------------------------------------------------
// Feed de actividad en vivo (RUN-ACTIVITY)
// ---------------------------------------------------------------------------

function activitySource(now: Date) {
  return {
    task: (runId: string, taskId: string) =>
      runId === "RUN-LIVE" && taskId === "T3"
        ? [{ tool: "bash", summary: "pnpm test", at: now.getTime() - 5_000 }]
        : [],
    orchestrator: (runId: string) =>
      runId === "RUN-LIVE"
        ? [{ tool: "aiapaec_orchestrate", summary: "objetivo del run", at: now.getTime() - 120_000 }]
        : [],
  }
}

test("activity: extrae tool y resumen de eventos V2, ignorando sesiones no registradas", () => {
  const feed = new ActivityFeed()
  feed.register("ses_a", "T1", { runId: "RUN-A", taskId: "T1" })

  // V2: el nombre del tool llega en input.started y el input en tool.called.
  feed.ingest({
    type: "session.tool.input.started",
    created: 1_700_000_000_000,
    data: { sessionID: "ses_a", id: "call_1", name: "read" },
  })
  feed.ingest({
    type: "session.tool.called",
    created: 1_700_000_001_000,
    data: { sessionID: "ses_a", id: "call_1", input: { filePath: "src/tools.ts" }, executed: true },
  })

  // Sesión no registrada: se ignora.
  feed.ingest({
    type: "session.tool.called",
    data: { sessionID: "ses_otra", id: "x", input: { path: "a.ts" } },
  })

  const items = feed.getActivity("ses_a")
  assert.equal(items.length, 1)
  assert.deepEqual(
    items.map((item) => [item.tool, item.summary]),
    [["read", "src/tools.ts"]],
  )
  assert.equal(feed.getLast("ses_a")!.tool, "read")
  assert.deepEqual(feed.getActivity("ses_otra"), [], "una sesión no registrada no acumula nada")
  feed.cleanup()
})

test("activity: el resumen se trunca a 80 caracteres y se colapsan espacios", () => {
  const long = `src/${"a".repeat(200)}.ts`
  const summary = summarizeToolInput({ filePath: long })
  assert.equal(summary.length, ACTIVITY_SUMMARY_MAX)
  assert.ok(summary.endsWith("…"), "el truncado se marca con elipsis")

  assert.equal(summarizeToolInput({ command: "pnpm test" }), "pnpm test")
  assert.equal(summarizeToolInput({ description: "revisar   el\nrepo" }), "revisar el repo")
  assert.equal(truncateSummary("  a\n b  "), "a b")
  assert.equal(summarizeToolInput({ deeper: { x: 1 } }), "", "sin argumentos de texto devuelve vacío")
  assert.equal(summarizeToolInput(["a", "b"]), "a b")
})

test("activity: ring buffer de 8 expulsa la acción más antigua", () => {
  const feed = new ActivityFeed()
  feed.register("ses_r")

  for (let index = 1; index <= 9; index++) {
    feed.ingest({
      type: "session.tool.called",
      created: 1_700_000_000_000 + index * 1000,
      data: { sessionID: "ses_r", id: `call_${index}`, input: { command: `cmd ${index}` } },
    })
  }

  const items = feed.getActivity("ses_r")
  assert.equal(items.length, ACTIVITY_BUFFER_SIZE)
  assert.equal(items[0]!.summary, "cmd 2", "el noveno expulsa al primero")
  assert.equal(items[items.length - 1]!.summary, "cmd 9")
  assert.equal(items.length, 8)
  feed.cleanup()
})

test("activity: registro por run/tarea, orquestador y desregistro", () => {
  const feed = new ActivityFeed()
  feed.register("ses_t1", "T1", { runId: "RUN-Z", taskId: "T1" })
  feed.register("ses_t2", "T2", { runId: "RUN-Z", taskId: "T2" })
  feed.register("ses_orq", "orquestador", { runId: "RUN-Z", role: "orchestrator" })

  const push = (sessionID: string, id: string, input: Record<string, unknown>) =>
    feed.ingest({
      type: "session.tool.called",
      created: Date.now(),
      data: { sessionID, id, input },
    })

  push("ses_t1", "a", { command: "pnpm test" })
  push("ses_t2", "b", { filePath: "README.md" })
  push("ses_orq", "c", { description: "delegar tareas" })

  assert.equal(feed.activityForTask("RUN-Z", "T1").length, 1)
  assert.equal(feed.lastForTask("RUN-Z", "T1")!.summary, "pnpm test")
  assert.equal(feed.lastForTask("RUN-Z", "T2")!.summary, "README.md")
  assert.equal(feed.orchestratorActivity("RUN-Z").length, 1)
  assert.deepEqual(feed.activityForTask("RUN-Z", "T9"), [])

  feed.unregister("ses_t1")
  assert.equal(feed.isRegistered("ses_t1"), false)
  assert.equal(feed.lastForTask("RUN-Z", "T1"), undefined)

  feed.unregisterRun("RUN-Z")
  assert.equal(feed.isRegistered("ses_t2"), false)
  assert.equal(feed.isRegistered("ses_orq"), false)
  feed.cleanup()
})

test("activity: la suscripción es best-effort ante un evento que lanza", async () => {
  const feed = new ActivityFeed()
  feed.register("ses_sub", "T1", { runId: "RUN-SUB", taskId: "T1" })

  const poison = {
    type: "session.tool.called",
    created: Date.now(),
    data: {
      sessionID: "ses_sub",
      id: "poison",
      input: {
        get filePath(): string {
          throw new Error("argumento roto")
        },
      },
    },
  }
  const valid = {
    type: "session.tool.called",
    created: Date.now(),
    data: { sessionID: "ses_sub", id: "ok", input: { command: "pnpm test" } },
  }

  async function* stream() {
    yield poison
    yield valid
  }

  await feed.subscribe({ event: { subscribe: () => stream() } })

  const items = feed.getActivity("ses_sub")
  assert.equal(items.length, 1, "el evento roto no corta el bucle")
  assert.equal(items[0]!.summary, "pnpm test")

  feed.cleanup()
  assert.deepEqual(feed.getActivity("ses_sub"), [], "cleanup vacía los buffers")
  assert.equal(feed.getLast("ses_sub"), undefined)
})

test("activity: formatTimeAgo en segundos, minutos y horas", () => {
  const now = new Date("2024-01-01T00:00:10.000Z")
  assert.equal(formatTimeAgo(now.getTime() - 500, now), "hace 0s")
  assert.equal(formatTimeAgo(now.getTime() - 5_000, now), "hace 5s")
  assert.equal(formatTimeAgo(now.getTime() - 59_000, now), "hace 59s")
  assert.equal(formatTimeAgo(now.getTime() - 120_000, now), "hace 2m")
  assert.equal(formatTimeAgo(now.getTime() - 3_600_000, now), "hace 1h")
  assert.equal(formatTimeAgo(now.getTime() + 5_000, now), "hace 0s", "un reloj adelantado no da negativos")
  assert.equal(formatTimeAgo(Number.NaN), "—")
})

test("dashboard v2: cada tarea en curso lleva activity y las cerradas no", () => {
  const now = new Date("2024-01-01T00:00:10.000Z")
  const view = buildDashboardView(dashboardRuns(), now, activitySource(now))

  assert.equal(view.version, 4, "el contrato de /api/state sube a v4 (árbol: title/model/sub-sesiones)")
  const running = view.active!.tasks.find((task) => task.taskId === "T3")!
  assert.equal(running.activity!.length, 1)
  assert.deepEqual({ ...running.activity![0] }, {
    tool: "bash",
    summary: "pnpm test",
    at: now.getTime() - 5_000,
    ago: "hace 5s",
  })

  const closed = view.active!.tasks.find((task) => task.taskId === "T1")!
  assert.equal(closed.activity, undefined, "las tareas cerradas no llevan activity")

  assert.equal(view.active!.orchestrator!.label, "orquestador")
  assert.equal(view.active!.orchestrator!.activity.length, 1)
  assert.equal(view.active!.orchestrator!.activity[0]!.ago, "hace 2m")

  // Sin fuente de actividad (o sin eventos) va vacío, nunca null roto.
  const empty = buildDashboardView(dashboardRuns(), now)
  assert.deepEqual(empty.active!.tasks.find((task) => task.taskId === "T3")!.activity, [])
  assert.deepEqual(empty.active!.orchestrator!.activity, [])
  assert.equal(empty.history[0]!.orchestrator, undefined, "el historial no lleva orquestador")
})

test("dashboard v2: la página pinta las acciones bajo la tarea en curso y el orquestador", () => {
  const now = new Date("2024-01-01T00:00:10.000Z")
  const html = renderDashboardHtml(buildDashboardView(dashboardRuns(), now, activitySource(now)), {
    refreshMs: DASHBOARD_REFRESH_MS,
  })

  assert.match(html, /class="activity-row"/)
  assert.match(html, /act-tool">bash</)
  assert.match(html, /hace 5s/)
  assert.match(html, /class="orch-activity"/)
  assert.match(html, /Actividad del orquestador/)

  const noActivity = renderDashboardHtml(buildDashboardView(dashboardRuns(), now), {
    refreshMs: DASHBOARD_REFRESH_MS,
  })
  assert.match(noActivity, /sin actividad registrada/, "sin eventos se muestra el aviso discreto")

  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"))
  assert.ok(script.includes("activityList"), "el refresco del cliente repinta la actividad")
  assert.doesNotThrow(() => new Function(script), "el JS embebido sigue siendo válido")
})

test("dashboard v2: /api/state expone activity por tarea y la sesión orquestadora", async () => {
  const ctx = makeCtx()
  await saveRun(ctx, {
    runId: "RUN-ACT-API",
    objective: "actividad",
    baseBranch: "dev",
    startedAt: new Date().toISOString(),
    status: "running",
    totalTasks: 1,
    inFlight: ["A1"],
    results: [],
  })

  const feed = getActivityFeed()
  feed.reset()
  feed.register("ses_orq_api", "orquestador", { runId: "RUN-ACT-API", role: "orchestrator" })
  feed.register("ses_task_api", "A1", { runId: "RUN-ACT-API", taskId: "A1", role: "task" })
  feed.ingest({
    type: "session.tool.input.started",
    data: { sessionID: "ses_task_api", id: "c1", name: "read" },
  })
  feed.ingest({
    type: "session.tool.called",
    created: Date.now(),
    data: { sessionID: "ses_task_api", id: "c1", input: { filePath: "src/index.ts" } },
  })
  feed.ingest({
    type: "session.tool.called",
    created: Date.now(),
    data: { sessionID: "ses_orq_api", id: "c2", input: { description: "delegar" } },
  })

  const handle = await startDashboard(ctx, 0)
  assert.ok(handle, "el dashboard debe arrancar")
  try {
    const state: any = await (await fetch(`${handle!.url}/api/state`)).json()
    assert.equal(state.version, DASHBOARD_STATE_VERSION, "el contrato de /api/state es v4")
    assert.equal(state.active.runId, "RUN-ACT-API")
    assert.equal(state.active.tasks[0].activity.length, 1)
    assert.equal(state.active.tasks[0].activity[0].tool, "read")
    assert.equal(state.active.tasks[0].activity[0].summary, "src/index.ts")
    assert.match(state.active.tasks[0].activity[0].ago, /^hace \d+[smhd]$/)
    assert.equal(state.active.orchestrator.label, "orquestador")
    assert.equal(state.active.orchestrator.activity[0].summary, "delegar")
  } finally {
    await handle!.close()
    feed.reset()
  }
})

test("tools: run_status añade la última acción de cada tarea en curso", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, TOOL_SETTINGS)
  const runStatus = tools.get("run_status")!

  await saveRun(ctx, {
    runId: "RUN-ACT-STATUS",
    objective: "en curso",
    baseBranch: "dev",
    startedAt: new Date().toISOString(),
    status: "running",
    totalTasks: 1,
    inFlight: ["S1"],
    results: [],
  })

  const feed = getActivityFeed()
  feed.reset()
  feed.register("ses_s1", "S1", { runId: "RUN-ACT-STATUS", taskId: "S1", role: "task" })
  feed.ingest({
    type: "session.tool.called",
    created: Date.now() - 5_000,
    data: { sessionID: "ses_s1", id: "c1", name: "bash", input: { command: "pnpm test" } },
  })

  try {
    const status = await runStatus.execute({ runId: "RUN-ACT-STATUS" })
    assert.match(String(status.content), /última acción: bash → pnpm test \(hace \d+s\)/)

    feed.reset()
    const withoutActivity = await runStatus.execute({ runId: "RUN-ACT-STATUS" })
    assert.ok(
      !String(withoutActivity.content).includes("última acción"),
      "sin actividad la línea se omite",
    )
  } finally {
    feed.reset()
  }
})

test("tools: qaLevel viaja al resultado, run_status lo muestra y el inválido cae a L2", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, TOOL_SETTINGS)
  const orchestrate = tools.get("orchestrate")!
  const runStatus = tools.get("run_status")!

  const started = await orchestrate.execute(
    {
      objective: "niveles de qa",
      runId: "RUN-QA-LEVEL",
      tasks: [
        { id: "Q1", agent: "qa", objective: "smoke", qaLevel: "L1" },
        { id: "Q2", agent: "qa", objective: "sin nivel" },
        { id: "Q3", agent: "qa", objective: "nivel roto", qaLevel: "L9" },
      ],
    },
    { sessionID: "ses_orq" },
  )

  assert.equal(started.metadata.ok, true)
  assert.match(String(started.content), /Avisos de `qaLevel`/, "el valor inválido se avisa en la respuesta")
  assert.equal(started.metadata.qaLevelWarnings.length, 1)

  const record = await waitForRun(ctx, "RUN-QA-LEVEL")
  const byId = new Map(record.results.map((entry) => [entry.taskId, entry]))
  assert.equal(byId.get("Q1")!.qaLevel, "L1")
  assert.equal(byId.get("Q2")!.qaLevel, "L2", "sin qaLevel el resultado queda en L2")
  assert.equal(byId.get("Q3")!.qaLevel, "L2", "el inválido cae a L2")

  const status = await runStatus.execute({ runId: "RUN-QA-LEVEL" })
  assert.match(String(status.content), /qa · L1/, "run_status muestra el nivel junto al agente")
  assert.match(String(status.content), /qa · L2/)

  const prompts = (ctx as any).__prompts as Array<{ taskId: string; text: string }>
  assert.match(prompts.find((entry) => entry.taskId === "Q1")!.text, /## Nivel de QA — L1/)
  assert.match(prompts.find((entry) => entry.taskId === "Q2")!.text, /## Nivel de QA — L2/)
})

test("tools: skills viajan al prompt, al resultado, persistencia y run_status", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, TOOL_SETTINGS)
  const orchestrate = tools.get("orchestrate")!
  const runStatus = tools.get("run_status")!

  const skillsSchema = orchestrate.input.properties.tasks.items.properties.skills
  assert.equal(skillsSchema.type, "array", "el schema de orchestrate acepta skills")
  assert.equal(skillsSchema.items.type, "string")

  const started = await orchestrate.execute(
    {
      objective: "skills por tarea",
      runId: "RUN-SKILLS",
      tasks: [
        { id: "S1", agent: "coder", objective: "implementar", skills: ["tdd", " tdd "] },
        {
          id: "S2",
          agent: "qa",
          objective: "validar",
          qaLevel: "L3",
          skills: ["code-review", "research", 7, ""],
        },
        { id: "S3", agent: "coder", objective: "sin skills" },
      ],
    },
    { sessionID: "ses_orq" },
  )

  assert.equal(started.metadata.ok, true, "valores raros en skills no abortan el plan")

  const record = await waitForRun(ctx, "RUN-SKILLS")
  const byId = new Map(record.results.map((entry) => [entry.taskId, entry]))
  assert.deepEqual(byId.get("S1")!.skills, ["tdd"], "deduplica y persiste las skills")
  assert.deepEqual(byId.get("S2")!.skills, ["code-review", "research"], "descarta valores inválidos")
  assert.equal(byId.get("S3")!.skills, undefined, "sin skills no se persiste la lista")

  const prompts = (ctx as any).__prompts as Array<{ taskId: string; text: string }>
  assert.match(prompts.find((entry) => entry.taskId === "S1")!.text, /## Skills a aplicar/)
  assert.match(prompts.find((entry) => entry.taskId === "S2")!.text, /code-review/)
  assert.ok(
    !prompts.find((entry) => entry.taskId === "S3")!.text.includes("## Skills a aplicar"),
    "la sección es condicional",
  )

  const status = await runStatus.execute({ runId: "RUN-SKILLS" })
  assert.match(String(status.content), /coder · L2 · tdd/, "run_status muestra el sufijo de skills")
  assert.match(String(status.content), /qa · L3 · code-review\+research/)
})

test("tools: orchestrate registra la sesión orquestadora y cada hija en el feed", async () => {
  const { ctx, tools } = makeToolCtx({ delayMs: 120 })
  const feed = getActivityFeed()
  feed.reset()
  await registerTools(ctx, TOOL_SETTINGS)

  await tools.get("orchestrate")!.execute(
    { objective: "feed", runId: "RUN-ACT-FEED", tasks: [{ id: "F1", agent: "contexto", objective: "x" }] },
    { sessionID: "ses_orq_feed" },
  )

  assert.equal(feed.isRegistered("ses_orq_feed"), true, "la sesión orquestadora se registra al iniciar")

  const started = Date.now()
  while (!feed.isRegistered("ses_test_1") && Date.now() - started < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(feed.isRegistered("ses_test_1"), true, "la sesión hija se registra al crearse")

  feed.ingest({
    type: "session.tool.called",
    created: Date.now(),
    data: { sessionID: "ses_test_1", id: "c1", input: { command: "pnpm test" } },
  })
  assert.equal(feed.lastForTask("RUN-ACT-FEED", "F1")!.summary, "pnpm test")

  await waitForRun(ctx, "RUN-ACT-FEED")
  assert.equal(feed.isRegistered("ses_test_1"), false, "al cerrar la tarea se desregistra")
  assert.equal(feed.isRegistered("ses_orq_feed"), false, "al cerrar el run se desregistra el orquestador")
  feed.reset()
})

test("cierre: la validación de rama rechaza vacía, protegidas y nombres inválidos", () => {
  const empty = validateBranch("")
  assert.equal(empty.ok, false)
  assert.match(String(empty.error), /Falta la rama/)

  assert.equal(validateBranch("   ").ok, false, "solo espacios no vale como rama")
  for (const protectedBranch of PROTECTED_BRANCHES) {
    assert.equal(validateBranch(protectedBranch).ok, false, `${protectedBranch} está protegida`)
  }
  assert.equal(validateBranch("MAIN").ok, false, "la comparación con las protegidas ignora mayúsculas")
  assert.equal(validateBranch(BASE_BRANCH).ok, false, "la base de integración nunca se cierra")
  assert.equal(validateBranch("feat/cierre-script").ok, true)
  assert.equal(validateBranch("feat/con espacios").ok, false)
  assert.equal(validateBranch("-rama").ok, false)
  assert.equal(validateBranch("feat/..mal").ok, false)
  assert.equal(validateBranch("feat/x~1").ok, false)
})

test("cierre: parsea rama, flags y runId", () => {
  const full = parseArgs(["feat/x", "--restart", "--run-id", "RUN-A"])
  assert.deepEqual(full, { branch: "feat/x", restart: true, runId: "RUN-A", help: false, errors: [] })

  const inline = parseArgs(["--run-id=RUN-B", "feat/y"])
  assert.equal(inline.branch, "feat/y")
  assert.equal(inline.runId, "RUN-B")
  assert.equal(inline.restart, false)

  const bare = parseArgs([])
  assert.equal(bare.branch, "")
  assert.equal(bare.runId, null)
  assert.equal(bare.errors.length, 0, "sin argumentos no hay error de sintaxis (lo detecta la validación)")

  assert.equal(parseArgs(["--run-id"]).errors.length, 1, "--run-id sin valor es error")
  assert.equal(parseArgs(["--run-id="]).errors.length, 1)
  assert.equal(parseArgs(["feat/x", "--bogus"]).errors.length, 1, "flag desconocido es error")
  assert.equal(parseArgs(["feat/x", "otra"]).errors.length, 1, "segunda rama es error")
  assert.equal(parseArgs(["--help"]).help, true)
  assert.equal(parseArgs(["-h"]).help, true)
  assert.equal(parseArgs(["--", "--raro"]).branch, "--raro", "tras -- todo es posicional")
})

test("cierre: el mensaje de merge incluye la rama y el runId cuando se detecta", () => {
  assert.equal(buildMergeMessage("feat/x", "RUN-A"), "merge: feat/x (RUN-A)")
  assert.equal(buildMergeMessage("feat/x", null), "merge: feat/x")
  assert.equal(buildMergeMessage("feat/x", "  "), "merge: feat/x")
  assert.equal(buildMergeMessage(" feat/x ", undefined), "merge: feat/x")
})

test("cierre: deduce el runId desde el nombre de la rama", () => {
  assert.equal(runIdFromBranch("feat/RUN-FASTFLOW-TASK-FF"), "RUN-FASTFLOW-TASK-FF")
  assert.equal(runIdFromBranch("feat/TASK-RUNHISTORY"), "TASK-RUNHISTORY")
  assert.equal(runIdFromBranch("feat/cierre-script"), null, "ramas en minúsculas no aportan runId")
  assert.equal(runIdFromBranch("feat/RUN-ACTIVITY-2"), "RUN-ACTIVITY-2")
  assert.equal(runIdFromBranch("RUN-LIVEDASH"), "RUN-LIVEDASH", "también sin prefijo feat/")
  assert.equal(runIdFromBranch("refs/heads/feat/RUN-PNPM"), "RUN-PNPM")
  assert.equal(runIdFromBranch(""), null)
  assert.equal(runIdFromBranch(null as unknown as string), null)
})

test("cierre: deriva la ruta del plan y descarta runIds inseguros", () => {
  assert.equal(planDocPath("RUN-A"), "docs/plans/RUN-A.md")
  assert.equal(planDocPath("RUN-A", "custom/planes/"), "custom/planes/RUN-A.md")
  assert.equal(planDocPath("RUN-A", "custom\\planes"), "custom/planes/RUN-A.md")
  assert.equal(planDocPath("RUN-A", "  "), "docs/plans/RUN-A.md", "carpeta vacía cae al default")
  assert.equal(planDocPath("../fuera"), null)
  assert.equal(planDocPath("a/b"), null)
  assert.equal(planDocPath("con espacio"), null)
  assert.equal(planDocPath(".."), null)
  assert.equal(planDocPath(null), null)
  assert.equal(planDocPath("RUN-A", "../fuera"), null)
})

test("cierre: rieles de working tree y rama ya mergeada", () => {
  assert.deepEqual(workingTreeBlockers(""), [])
  assert.deepEqual(workingTreeBlockers("  \n "), [])
  assert.deepEqual(workingTreeBlockers(null), [], "salida vacía del comando cuenta como limpio")
  assert.deepEqual(workingTreeBlockers(" M scripts/cierre.mjs"), ["M scripts/cierre.mjs"])
  assert.deepEqual(workingTreeBlockers("?? nuevo.txt"), ["?? nuevo.txt"])
  assert.deepEqual(
    workingTreeBlockers("?? docs/plans/RUN-A.md", "docs/plans/RUN-A.md"),
    [],
    "el plan del run se tolera sin trackear",
  )
  assert.deepEqual(
    workingTreeBlockers("?? docs/plans/RUN-B.md", "docs/plans/RUN-A.md"),
    ["?? docs/plans/RUN-B.md"],
    "un plan de otro run sí bloquea",
  )
  assert.deepEqual(
    workingTreeBlockers("?? docs/", "docs/plans/RUN-A.md"),
    [],
    "porcelain puede colapsar la carpeta del plan",
  )
  assert.deepEqual(
    workingTreeBlockers(" M src/x.ts\n?? docs/plans/RUN-A.md", "docs/plans/RUN-A.md"),
    ["M src/x.ts"],
    "un archivo modificado sigue bloqueando",
  )
  assert.deepEqual(workingTreeBlockers("?? docs/plans/RUN-A.md"), ["?? docs/plans/RUN-A.md"], "sin plan conocido todo bloquea")

  assert.equal(isAlreadyMerged({ branchHead: "abc", mergeBase: "abc" }), true)
  assert.equal(isAlreadyMerged({ branchHead: "abc", mergeBase: "def" }), false)
  assert.equal(isAlreadyMerged({ branchHead: "", mergeBase: "" }), false)
  assert.equal(isAlreadyMerged({}), false)
})

test("cierre: el CLI solo corre cuando el archivo es el entrypoint", () => {
  assert.equal(isEntrypoint("C:/repo/scripts/cierre.mjs", "C:/repo/scripts/cierre.mjs"), true)
  assert.equal(isEntrypoint("C:/repo/scripts/cierre.mjs", "C:/repo/.tmp/smoke.mjs"), false)
  assert.equal(isEntrypoint("C:/repo/scripts/cierre.mjs", ""), false)
  assert.equal(isEntrypoint("C:/repo/scripts/cierre.mjs", undefined as unknown as string), false)
  assert.equal(
    isEntrypoint("C:/repo/.tmp/smoke.mjs", "C:/repo/.tmp/smoke.mjs"),
    false,
    "el bundle de esbuild no debe disparar el CLI",
  )
  assert.equal(isEntrypoint("C:/repo/scripts/otro.mjs", "C:/repo/scripts/otro.mjs"), false)
})

// ---------------------------------------------------------------------------
// Árbol de ejecución (contrato v4): títulos, modelos, cascada y sub-sesiones
// ---------------------------------------------------------------------------

test("tipos: shortTitle usa la primera línea y modelLabel normaliza provider/model", () => {
  assert.equal(shortTitle("primera línea\nsegunda línea"), "primera línea")
  assert.equal(shortTitle("  espacios   de sobra  "), "espacios de sobra")
  assert.equal(shortTitle(""), "")
  assert.equal(shortTitle(undefined), "")

  const long = shortTitle("x".repeat(80))
  assert.equal(long.length, SHORT_TITLE_MAX)
  assert.ok(long.endsWith("…"))

  assert.equal(modelLabel({ providerID: "opencode-go", id: "glm-5.3" }), "opencode-go/glm-5.3")
  assert.equal(modelLabel({ providerID: "p", id: "m", variant: "fast" }), "p/m#fast")
  assert.equal(modelLabel("opencode-go/x"), "opencode-go/x")
  assert.equal(modelLabel({ id: "sin-provider" }), undefined)
  assert.equal(modelLabel(undefined), undefined)
})

test("tipos: inFlightEntries tolera el historial v3 (IDs) y normaliza los objetos v4", () => {
  const legacy = inFlightEntries(["T1", " "])
  assert.equal(legacy.length, 1, "descarta IDs vacíos")
  assert.equal(legacy[0]!.taskId, "T1")
  assert.equal(legacy[0]!.agent, "—", "un ID heredado no conoce el agente")

  const modern = inFlightEntries([
    {
      taskId: " T2 ",
      agent: "coder",
      model: "opencode-go/glm-5.3-flash",
      branch: "feat/T2",
      startedAt: "2024-01-01T00:00:00.000Z",
      title: "Capa de datos",
    },
    { agent: "sin-id" },
  ])
  assert.equal(modern.length, 1)
  assert.equal(modern[0]!.taskId, "T2")
  assert.equal(modern[0]!.agent, "coder")
  assert.equal(modern[0]!.model, "opencode-go/glm-5.3-flash")
  assert.equal(modern[0]!.branch, "feat/T2")
  assert.equal(modern[0]!.title, "Capa de datos")
  assert.deepEqual(inFlightEntries(undefined), [])
})

test("activity: la cascada registra las sub-sesiones de una sesión observada", () => {
  const feed = new ActivityFeed()
  feed.register("ses_orq_tree", "orquestador", {
    runId: "RUN-TREE",
    role: "orchestrator",
    agent: "orquestador",
  })
  feed.register("ses_task_tree", "T1", {
    runId: "RUN-TREE",
    taskId: "T1",
    role: "task",
    agent: "coder",
    title: "Implementar la capa de datos",
  })

  feed.ingest({
    type: "session.created",
    created: Date.now(),
    data: {
      sessionID: "ses_child_tree",
      parentID: "ses_task_tree",
      title: "[orq] explorar dependencias",
      agent: "explore",
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      // El runner deja el título corto del nodo en la metadata de la sesión.
      metadata: { title: "Explorar dependencias" },
    },
  })

  assert.equal(feed.isRegistered("ses_child_tree"), true, "la hija de una sesión observada entra sola")
  const child = feed.sessionInfo("ses_child_tree")!
  assert.equal(child.role, "sub")
  assert.equal(child.agent, "explore")
  assert.equal(child.model, "opencode-go/deepseek-v4.1-flash")
  assert.equal(child.title, "Explorar dependencias")
  assert.equal(child.taskId, "T1", "hereda la tarea del padre")
  assert.equal(feed.childrenOf("ses_task_tree").length, 1)
  assert.equal(feed.sessionsForRun("RUN-TREE").length, 3)

  feed.ingest({
    type: "session.tool.called",
    created: Date.now(),
    data: { sessionID: "ses_child_tree", id: "c1", name: "read", input: { filePath: "src/types.ts" } },
  })
  assert.equal(feed.sessionInfo("ses_child_tree")!.activity[0]!.summary, "src/types.ts")
  assert.equal(
    feed.activityForTask("RUN-TREE", "T1").length,
    1,
    "la actividad de la sub-sesión se atribuye a la tarea",
  )

  // Sin padre observado no hay cascada (no se inventan sesiones).
  feed.ingest({
    type: "session.created",
    data: { sessionID: "ses_huerfana", parentID: "ses_desconocida", agent: "x" },
  })
  assert.equal(feed.isRegistered("ses_huerfana"), false)

  // La cascada no degrada un rol ya asignado ni pisa el título del runner.
  feed.register("ses_child_tree", "T1", { taskId: "T1", role: "task", agent: "coder" })
  assert.equal(feed.sessionInfo("ses_child_tree")!.role, "task")
  assert.equal(feed.sessionInfo("ses_child_tree")!.title, "Explorar dependencias")
  feed.cleanup()
})

test("runner: captura el modelo esperado del agente y el modelo real del assistant", async () => {
  const ctx = makeCtx({ delayMs: 1 })
  const starts: Array<{ taskId: string; model?: string; title?: string; startedAt?: string }> = []

  const run = await runOrchestration({
    ctx,
    runId: "RUN-MODEL",
    input: {
      objective: "modelos por nodo",
      tasks: [
        { id: "M1", agent: "coder", objective: "implementar" },
        { id: "M2", agent: "contexto", objective: "memoria" },
        { id: "M3", agent: "qa", objective: "validar", model: "opencode-go/glm-5.3-flash#fast" },
      ],
    },
    baseBranch: "dev",
    workdir: "C:/repo",
    keepSessions: true,
    onTaskStart: (info) => {
      starts.push(info)
    },
  })

  const created = (ctx as any).__created as any[]
  const m1 = created.find((session) => session.metadata?.taskId === "M1")
  assert.deepEqual(
    m1.model,
    { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    "el modelo esperado sale del agente",
  )

  const m2 = created.find((session) => session.metadata?.taskId === "M2")
  assert.equal(m2.model, undefined, "un agente sin modelo no envía model")

  const m3 = created.find((session) => session.metadata?.taskId === "M3")
  assert.deepEqual(m3.model, { providerID: "opencode-go", id: "glm-5.3-flash", variant: "fast" })

  const startM1 = starts.find((info) => info.taskId === "M1")!
  assert.equal(startM1.model, "opencode-go/deepseek-v4.1-flash")
  assert.equal(startM1.title, "implementar")
  assert.match(startM1.startedAt!, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(starts.find((info) => info.taskId === "M2")!.model, undefined)

  const byId = new Map(run.results.map((entry) => [entry.taskId, entry]))
  assert.equal(
    byId.get("M1")!.model,
    "opencode-go/deepseek-v4.1-flash",
    "el modelo REAL del assistant manda",
  )
  assert.equal(
    byId.get("M3")!.model,
    "opencode-go/deepseek-v4.1-flash",
    "el real del assistant prevalece sobre el override esperado",
  )
  assert.equal(byId.get("M1")!.title, "implementar")
  assert.equal(m1.metadata.title, "implementar", "el título corto viaja en la metadata de la sesión")
})

test("tools: inFlight se persiste como objetos con título, agente y modelo", async () => {
  const { ctx, tools } = makeToolCtx({ delayMs: 150 })
  await registerTools(ctx, TOOL_SETTINGS)
  const orchestrate = tools.get("orchestrate")!
  const runStatus = tools.get("run_status")!

  const started = await orchestrate.execute(
    {
      objective: "árbol de ejecución\nsegunda línea del objetivo",
      title: "Árbol v4",
      runId: "RUN-TREE-DATA",
      tasks: [
        { id: "D1", agent: "coder", objective: "Implementar la capa de datos del árbol\ncon detalle" },
      ],
    },
    { sessionID: "ses_orq" },
  )
  assert.equal(started.metadata.ok, true)

  let record = await getRun(ctx, "RUN-TREE-DATA")
  const deadline = Date.now() + 2000
  while ((!record?.inFlight || record.inFlight.length === 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    record = await getRun(ctx, "RUN-TREE-DATA")
  }

  assert.equal(record!.title, "Árbol v4", "el título del run llega al registro")
  const entry: any = record!.inFlight![0]
  assert.equal(typeof entry, "object", "inFlight son objetos en el contrato v4")
  assert.equal(entry.taskId, "D1")
  assert.equal(entry.agent, "coder")
  assert.equal(entry.model, "opencode-go/deepseek-v4.1-flash")
  assert.equal(entry.branch, "feat/D1")
  assert.match(entry.startedAt, /^\d{4}-\d{2}-\d{2}T/)

  const status = await runStatus.execute({ runId: "RUN-TREE-DATA" })
  const text = String(status.content)
  assert.match(text, /## Orquestación — Árbol v4/)
  assert.match(text, /En curso:/)
  assert.match(text, /· Implementar la capa de datos del árbol · coder · opencode-go\/deepseek-v4\.1-flash/)

  const final = await waitForRun(ctx, "RUN-TREE-DATA")
  assert.equal(final.inFlight?.length, 0, "al cerrar el run no quedan tareas en vuelo")
  assert.equal(final.results[0]!.title, "Implementar la capa de datos del árbol")
  assert.equal(final.results[0]!.model, "opencode-go/deepseek-v4.1-flash")

  const sessions = (ctx as any).__created as any[]
  assert.equal(sessions[0]!.metadata.title, "Implementar la capa de datos del árbol")

  // Sin agente/modelo conocidos, run_status muestra `default`.
  await saveRun(ctx, {
    runId: "RUN-TREE-DEFAULT",
    objective: "sin modelo",
    baseBranch: "dev",
    startedAt: new Date().toISOString(),
    status: "running",
    totalTasks: 1,
    inFlight: [toInFlightTask({ taskId: "N1", agent: "contexto", title: "Memoria" })],
    results: [],
  })
  const fallback = await runStatus.execute({ runId: "RUN-TREE-DEFAULT" })
  assert.match(String(fallback.content), /contexto · default/)
})

test("dashboard v4: /api/state expone título, modelo, inFlight objetos y sub-sesiones", async () => {
  const ctx = makeCtx()
  const feed = getActivityFeed()
  feed.reset()

  await saveRun(ctx, {
    runId: "RUN-TREE-API",
    objective:
      "objetivo larguísimo que no debe caber en el nodo raíz porque supera los sesenta caracteres de sobra",
    title: "Árbol v4",
    baseBranch: "dev",
    startedAt: new Date().toISOString(),
    status: "running",
    totalTasks: 2,
    inFlight: [
      toInFlightTask({
        taskId: "A1",
        agent: "coder",
        model: "opencode-go/deepseek-v4.1-flash",
        branch: "feat/A1",
        startedAt: "2024-01-01T00:00:00.000Z",
        title: "Capa de datos",
      }),
    ],
    results: [
      {
        taskId: "A0",
        agent: "contexto",
        status: "succeeded",
        title: "Contexto previo",
        model: "opencode-go/glm-5.3-flash",
        summary: "ok",
      },
    ],
  })

  feed.register("ses_orq_tree_api", "orquestador", {
    runId: "RUN-TREE-API",
    role: "orchestrator",
    agent: "orquestador",
  })
  feed.register("ses_a1", "A1", {
    runId: "RUN-TREE-API",
    taskId: "A1",
    role: "task",
    agent: "coder",
    model: "opencode-go/deepseek-v4.1-flash",
    title: "Capa de datos",
    parentID: "ses_orq_tree_api",
  })
  feed.ingest({
    type: "session.created",
    created: Date.now(),
    data: {
      sessionID: "ses_a1_child",
      parentID: "ses_a1",
      agent: "explore",
      model: { providerID: "opencode-go", id: "glm-5.3-flash" },
      title: "[orq] explorar",
      metadata: { title: "Explorar dependencias" },
    },
  })
  feed.ingest({
    type: "session.tool.called",
    created: Date.now(),
    data: { sessionID: "ses_a1_child", id: "k1", name: "read", input: { filePath: "src/runner.ts" } },
  })

  const handle = await startDashboard(ctx, 0)
  assert.ok(handle, "el dashboard debe arrancar")
  try {
    const state: any = await (await fetch(`${handle!.url}/api/state`)).json()

    assert.equal(state.version, DASHBOARD_STATE_VERSION)
    assert.equal(state.active.title, "Árbol v4")
    assert.equal(state.active.inFlight.length, 1)
    assert.equal(typeof state.active.inFlight[0], "object")
    assert.equal(state.active.inFlight[0].taskId, "A1")
    assert.equal(state.active.inFlight[0].model, "opencode-go/deepseek-v4.1-flash")
    assert.equal(state.active.inFlight[0].startedAt, "2024-01-01T00:00:00.000Z")

    const closed: any = state.active.tasks.find((task: any) => task.taskId === "A0")
    assert.equal(closed.title, "Contexto previo")
    assert.equal(closed.model, "opencode-go/glm-5.3-flash")

    const running: any = state.active.tasks.find((task: any) => task.taskId === "A1")
    assert.equal(running.isRunning, true)
    assert.equal(running.title, "Capa de datos")
    assert.equal(running.model, "opencode-go/deepseek-v4.1-flash")
    assert.equal(running.branch, "feat/A1")
    assert.equal(running.subsessions.length, 1, "el nodo cuelga de su sub-sesión")
    assert.equal(running.subsessions[0].id, "ses_a1_child")
    assert.equal(running.subsessions[0].agent, "explore")
    assert.equal(running.subsessions[0].model, "opencode-go/glm-5.3-flash")
    assert.equal(running.subsessions[0].title, "Explorar dependencias")
    assert.equal(running.subsessions[0].activity[0].tool, "read")
    assert.match(running.subsessions[0].activity[0].ago, /^hace \d+[smhd]$/)

    assert.equal(state.active.orchestrator.subsessions.length, 1, "el orquestador es la raíz del árbol")
    assert.equal(state.active.orchestrator.subsessions[0].id, "ses_a1")
    assert.equal(state.active.orchestrator.subsessions[0].subsessions[0].id, "ses_a1_child")

    const page = await (await fetch(`${handle!.url}/`)).text()
    assert.match(page, /Aiapaec · árbol de ejecución/)
  } finally {
    await handle!.close()
    feed.reset()
  }
})

test("plandocs: el título corto del run y de cada tarea aparece en el plan", () => {
  const markdown = renderPlanMarkdown({
    workdir: "C:/repo",
    folder: "docs/plans",
    runId: "RUN-TITLE",
    objective: "objetivo largo del run",
    title: "Árbol v4",
    baseBranch: "dev",
    startedAt: "2024-01-01T00:00:00.000Z",
    status: "running",
    tasks: [
      { id: "T1", agent: "coder", objective: "objetivo largo", title: "Capa de datos" },
      { id: "T2", agent: "qa", objective: "sin título declarado" },
    ],
    results: [],
    inFlight: [toInFlightTask({ taskId: "T2", agent: "qa", title: "Validar" })],
  })

  assert.match(markdown, /title: Árbol v4/)
  assert.match(markdown, /\| ID \| Agente \| Estado \| Rama \| Depende de \| Título \|/)
  assert.match(markdown, /\| T1 \| coder \| ⏭️ skipped \| — \| — \| Capa de datos \|/)
  assert.match(markdown, /\| T2 \| qa \| ⏳ running \| — \| — \| — \|/)
})

// Dashboard v4: árbol de ejecución, historial compacto y estado preservado
// ---------------------------------------------------------------------------

function treeRuns(): RunRecord[] {
  return [
    {
      runId: "RUN-TREE",
      title: "Árbol del dashboard",
      objective: "Rediseñar el dashboard como árbol\ncon conectores y anti-ruido",
      baseBranch: "dev",
      startedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
      totalTasks: 2,
      // Contrato v4: inFlight pasa a objetos con agente/modelo/sesión.
      inFlight: [
        {
          taskId: "T-RUN",
          agent: "coder",
          model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
          branch: "feat/treeview-ui",
          startedAt: "2024-01-01T00:00:05.000Z",
          sessionID: "ses_coder",
        },
      ],
      results: [
        {
          taskId: "T-CTX",
          title: "Contexto engram",
          agent: "contexto",
          model: "opencode-go/deepseek-v4.1-flash",
          status: "succeeded",
          sessionID: "ses_ctx",
          latencyMs: 1200,
          summary: "reporte corto del contexto",
        },
      ],
      sessions: [
        { sessionID: "ses_orq", role: "orchestrator", agent: "build", model: "opencode-go/deepseek-v4.1-flash" },
        { sessionID: "ses_ctx", parentID: "ses_orq", agent: "contexto", status: "completed" },
        { sessionID: "ses_coder", parentID: "ses_orq", agent: "coder", status: "running" },
        {
          sessionID: "ses_sub1",
          parentID: "ses_coder",
          title: "explore ts",
          agent: "explore",
          model: "opencode-go/glm-5",
          status: "busy",
        },
        { sessionID: "ses_sub2", parentID: "ses_sub1", title: "grep profundo", agent: "explore", status: "idle" },
      ],
    },
  ] as unknown as RunRecord[]
}

test("dashboard v4: el árbol anida orquestador → tareas → sub-sesiones", () => {
  const now = new Date("2024-01-01T00:00:10.000Z")
  const view = buildDashboardView(treeRuns(), now)
  const active = view.active!

  assert.equal(active.title, "Árbol del dashboard", "el título corto se usa tal cual")
  assert.equal(active.orchestrator!.label, "orquestador")
  assert.equal(active.orchestrator!.agent, "build", "la sesión raíz aporta el agente del nodo")
  assert.equal(active.orchestrator!.model, "opencode-go/deepseek-v4.1-flash")

  const closed = active.tasks.find((task) => task.taskId === "T-CTX")!
  assert.equal(closed.title, "Contexto engram")
  assert.equal(closed.model, "opencode-go/deepseek-v4.1-flash")
  assert.equal(closed.subsessions, undefined, "la sesión propia de la tarea no se duplica como hija")

  const running = active.tasks.find((task) => task.taskId === "T-RUN")!
  assert.equal(running.isRunning, true)
  assert.equal(running.agent, "coder")
  assert.equal(running.model, "opencode-go/deepseek-v4.1-flash", "el modelo en objeto se normaliza")
  assert.equal(running.title, "T-RUN", "sin título la tarea cae a su ID")
  assert.equal(running.time, "5.0s", "el tiempo sale del startedAt de la tarea en vuelo")

  const explore = running.subsessions![0]!
  assert.equal(explore.title, "explore ts")
  assert.equal(explore.status, "running", "busy se traduce a en curso")
  assert.equal(explore.children.length, 1, "cascada de nietas")
  assert.equal(explore.children[0]!.title, "grep profundo")
  assert.equal(explore.children[0]!.status, "succeeded", "idle se traduce a cerrada")

  const html = renderDashboardHtml(view)
  assert.match(html, /<ul class="tree">/)
  assert.match(html, /<ul class="children">/)
  assert.match(html, /class="node node-orch"/)
  assert.match(html, /class="node node-task/)
  assert.match(html, /class="node node-session/)
  assert.match(html, /chip">build · opencode-go\/deepseek-v4\.1-flash</)
  assert.match(html, /chip">coder · opencode-go\/deepseek-v4\.1-flash</)
  assert.match(html, /chip">explore · opencode-go\/glm-5</)
  assert.match(html, /explore ts/)
  assert.match(html, /grep profundo/)

  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"))
  assert.ok(script.includes("sessionNode"), "el refresco del cliente repinta las sub-sesiones")
  assert.doesNotThrow(() => new Function(script), "el JS embebido sigue siendo válido")
})

test("dashboard v4: un estado v3 se pinta con fallbacks (sin title/model/subsessions)", () => {
  const view = buildDashboardView(dashboardRuns(), new Date("2024-01-01T00:00:10.000Z"))
  const active = view.active!

  assert.equal(active.title, "objetivo <live>", "sin título cae a la primera línea del objetivo")
  assert.equal(active.tasks[0]!.title, "ok", "sin título de tarea cae a la primera línea del summary")
  assert.equal(active.tasks[0]!.model, undefined)
  assert.equal(active.tasks[2]!.title, "T3", "la tarea en vuelo sin título cae a su ID")
  assert.equal(active.tasks[2]!.agent, "—", "inFlight en strings no aporta agente")
  assert.equal(active.orchestrator!.agent, undefined)
  assert.equal(active.orchestrator!.subsessions, undefined)

  const html = renderDashboardHtml(view)
  assert.match(html, /<ul class="tree">/)
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"))
  assert.doesNotThrow(() => new Function(script))
})

test("dashboard v4: el historial es una línea compacta (título · fecha · resultado)", () => {
  assert.equal(formatStamp("2023-12-31T00:00:00.000Z"), "31 dic 00:00")
  assert.equal(formatStamp("no-es-fecha"), "—")
  assert.equal(shortText("primera\nsegunda"), "primera")
  assert.equal(formatChip("coder", "opencode-go/deepseek-v4.1-flash"), "coder · opencode-go/deepseek-v4.1-flash")
  assert.equal(formatChip("coder"), "coder")

  const view = buildDashboardView(dashboardRuns(), new Date("2024-01-01T00:00:10.000Z"))
  const old = view.history[0]!
  assert.equal(old.compact, "viejo · 31 dic 00:00 · completada · 1/1")

  const html = renderDashboardHtml(view)
  assert.ok(
    html.includes(`<summary class="run-summary">${old.compact}</summary>`),
    "el historial por defecto es la línea compacta",
  )
  assert.match(html, /data-state-id="run:RUN-OLD"/, "al desplegar el historial se ve su árbol")
  assert.match(html, /class="node node-task tone-ok"/)
})

test("dashboard v4: el estado abierto de los details sobrevive a un doble render", () => {
  const script = renderDetailsStateScript()
  assert.ok(script.includes("snapshotDetailsState"))
  assert.ok(script.includes("restoreDetailsState"))

  interface FakeNode {
    getAttribute(name: string): string | null
    hasAttribute(name: string): boolean
    setAttribute(name: string, value: string): void
    removeAttribute(name: string): void
  }

  const makeNode = (stateId: string, open = false): FakeNode => {
    const attrs = new Map<string, string>([["data-state-id", stateId]])
    if (open) attrs.set("open", "")
    return {
      getAttribute: (name) => (attrs.has(name) ? (attrs.get(name) as string) : null),
      hasAttribute: (name) => attrs.has(name),
      setAttribute: (name, value) => {
        attrs.set(name, value)
      },
      removeAttribute: (name) => {
        attrs.delete(name)
      },
    }
  }

  const dom = { nodes: [] as FakeNode[] }
  const documentStub = { querySelectorAll: () => dom.nodes }
  const api = new Function(
    "document",
    `${script}\nreturn { snapshot: snapshotDetailsState, restore: restoreDetailsState, state: detailsOpen };`,
  )(documentStub) as { snapshot: () => void; restore: () => void; state: Record<string, boolean> }

  // Render 1: el usuario despliega el historial.
  dom.nodes = [makeNode("run:RUN-OLD", true), makeNode("spec:RUN-OLD"), makeNode("history")]
  api.snapshot()
  assert.equal(api.state["run:RUN-OLD"], true)
  assert.equal(api.state["spec:RUN-OLD"], undefined)

  // Render 2 (polling): nodos nuevos, todos cerrados, uno de ellos inédito.
  dom.nodes = [makeNode("run:RUN-OLD"), makeNode("spec:RUN-OLD"), makeNode("history"), makeNode("task:RUN-NEW:T1")]
  api.restore()

  assert.equal(dom.nodes[0]!.hasAttribute("open"), true, "el historial desplegado no se colapsa solo")
  assert.equal(dom.nodes[1]!.hasAttribute("open"), false, "los que estaban cerrados siguen cerrados")
  assert.equal(dom.nodes[3]!.hasAttribute("open"), false, "un nodo nuevo arranca cerrado")

  // Y el histórico del usuario se olvida si lo cierra.
  dom.nodes[0]!.removeAttribute("open")
  api.snapshot()
  assert.equal(api.state["run:RUN-OLD"], undefined)
})

test("dashboard v4: la URL va en la cabecera y el polling reaplica el estado", () => {
  const html = renderDashboardHtml(buildDashboardView(dashboardRuns()), { url: "http://127.0.0.1:4790" })
  assert.match(html, /<span id="dash-url" class="mono url">http:\/\/127\.0\.0\.1:4790<\/span>/)

  assert.ok(
    renderDashboardHtml(buildDashboardView([])).includes(DEFAULT_DASHBOARD_URL),
    "sin url explícita se muestra la del puerto por defecto",
  )
  assert.equal(DEFAULT_DASHBOARD_URL, DASHBOARD_URL, "la página y el script coinciden en el puerto 4780")

  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"))
  assert.match(script, /details\[data-state-id\]/)
  assert.ok(
    script.indexOf("snapshotDetailsState();") < script.indexOf("restoreDetailsState();"),
    "se guarda el estado antes de repintar y se reaplica después",
  )
  assert.doesNotThrow(() => new Function(script))
})

test("dashboard: el script abre msedge --app, cae a chrome y luego al navegador por defecto", async () => {
  assert.equal(DASHBOARD_PORT, 4780)
  assert.equal(DASHBOARD_URL, "http://127.0.0.1:4780")
  assert.match(portWarning(), /dashboardPort/, "avisa que el puerto va hardcodeado")

  const env = {
    ProgramFiles: "C:\\PF",
    "ProgramFiles(x86)": "C:\\PF86",
    LOCALAPPDATA: "C:\\LA",
    USERPROFILE: "C:\\U",
  }
  const edge = "C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe"
  const chrome = "C:\\PF\\Google\\Chrome\\Application\\chrome.exe"

  const withBoth = buildLaunchPlan({ env, platform: "win32", exists: (file: string) => file === edge || file === chrome })
  assert.equal(withBoth[0]!.command, edge, "Edge primero")
  assert.equal(withBoth[0]!.kind, "app")
  assert.deepEqual(withBoth[0]!.args, [`--app=${DASHBOARD_URL}`])
  assert.equal(withBoth[1]!.command, chrome, "Chrome como respaldo")
  assert.equal(withBoth.at(-1)!.kind, "default", "el último paso es la apertura normal")
  assert.deepEqual(withBoth.at(-1)!.args, ["/c", "start", "", DASHBOARD_URL])

  const chromeOnly = buildLaunchPlan({ env, platform: "win32", exists: (file: string) => file === chrome })
  assert.equal(chromeOnly[0]!.command, chrome)
  assert.equal(chromeOnly.length, 2)

  const none = buildLaunchPlan({ env, platform: "win32", exists: () => false })
  assert.equal(none.length, 1)
  assert.equal(none[0]!.kind, "default")

  const linux = buildLaunchPlan({ env, platform: "linux", exists: () => true })
  assert.equal(linux[0]!.command, "xdg-open")
  assert.equal(browserCandidates(env, "linux").length, 0, "sin candidatos Chromium fuera de Windows")

  // Si el primer navegador no arranca (ENOENT), se prueba el siguiente.
  const attempts: string[] = []
  const step = await openDashboard({
    env,
    platform: "win32",
    exists: (file: string) => file === edge || file === chrome,
    log: { log: () => {}, error: () => {} },
    spawn: ((command: string) => {
      attempts.push(command)
      const child: any = {
        on: (event: string, handler: () => void) => {
          if (event === "error" && command === edge) handler()
        },
        unref: () => {},
      }
      return child
    }) as any,
  })
  assert.deepEqual(attempts, [edge, chrome])
  assert.equal(step!.command, chrome, "gana el primer navegador que arranca")

  assert.equal(
    isDashboardEntrypoint("C:/repo/scripts/abrir-dashboard.mjs", "C:/repo/scripts/abrir-dashboard.mjs"),
    true,
  )
  assert.equal(isDashboardEntrypoint("C:/repo/scripts/abrir-dashboard.mjs", "C:/repo/.tmp/smoke.mjs"), false)
})


// ---------------------------------------------------------------------------
// Perfiles de modelos (RUN-MPROFILES)
// ---------------------------------------------------------------------------

test("modelProfiles: built-ins y fusión con los perfiles del usuario", () => {
  assert.deepEqual(Object.keys(BUILT_IN_MODEL_PROFILES), ["high", "balanced", "low", "free"])
  assert.equal(BUILT_IN_MODEL_PROFILES.high!.orquestador, `${MODEL_PROFILE_PROVIDER}/gemini-4-argon`)
  assert.equal(BUILT_IN_MODEL_PROFILES.high!.coder, `${MODEL_PROFILE_PROVIDER}/kimi-k3.1-pro`)
  assert.equal(BUILT_IN_MODEL_PROFILES.high!.deployer, `${MODEL_PROFILE_PROVIDER}/deepseek-v4-pro`)
  assert.equal(BUILT_IN_MODEL_PROFILES.balanced!.coder, `${MODEL_PROFILE_PROVIDER}/kimi-k2.7-code`)
  assert.equal(BUILT_IN_MODEL_PROFILES.low!.explorador, `${MODEL_PROFILE_PROVIDER}/mimo-v2.6-flash`)
  for (const model of Object.values(BUILT_IN_MODEL_PROFILES.free!)) {
    assert.equal(model, `${MODEL_PROFILE_PROVIDER}/beam-free`, "free usa beam-free en todos los agentes")
  }

  // Un perfil con el mismo nombre se fusiona agente a agente: las claves del
  // usuario mandan y el resto se conserva del built-in.
  const merged = resolveModelProfiles({
    high: { coder: "custom/pro", qa: "" },
    barato: { coder: "custom/flash" },
    roto: { coder: 7 },
    "   ": { coder: "x/y" },
  })
  assert.equal(merged.high!.coder, "custom/pro", "el usuario sobrescribe por agente")
  assert.equal(merged.high!.orquestador, "opencode-go/gemini-4-argon", "el resto viene del built-in")
  assert.equal(merged.high!.qa, "opencode-go/glm-5.3", "un valor vacío no pisa el built-in")
  assert.deepEqual(merged.barato, { coder: "custom/flash" }, "los perfiles nuevos se añaden")
  assert.equal(merged.roto, undefined, "un perfil sin entradas válidas se descarta")

  assert.equal(BUILT_IN_MODEL_PROFILES.high!.coder, "opencode-go/kimi-k3.1-pro", "los built-in no se mutan")
  assert.equal(profileModel(merged.high, "coder"), "custom/pro")
  assert.equal(profileModel(merged.high, "desconocido"), undefined)

  assert.deepEqual(splitModelRef("opencode-go/glm-5.3#fast"), {
    providerID: "opencode-go",
    id: "glm-5.3",
    variant: "fast",
  })
  assert.equal(splitModelRef("sin-proveedor"), undefined)
  assert.equal(splitModelRef("opencode-go/"), undefined)
})

test("modelProfiles: precedencia task.model > perfil > agente y persistencia", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, {
    ...TOOL_SETTINGS,
    modelProfiles: resolveModelProfiles({}),
    defaultModelProfile: "balanced",
  })
  const orchestrate = tools.get("orchestrate")!
  const runStatus = tools.get("run_status")!

  assert.equal(orchestrate.input.properties.modelProfile.type, "string", "orchestrate acepta modelProfile")

  const started = await orchestrate.execute(
    {
      objective: "perfiles de modelos",
      runId: "RUN-PROFILE-PREC",
      tasks: [
        { id: "P1", agent: "coder", objective: "perfil balanced" },
        { id: "P2", agent: "coder", objective: "override explícito", model: "custom/manual" },
        { id: "P3", agent: "contexto", objective: "perfil balanced" },
      ],
    },
    { sessionID: "ses_orq" },
  )
  assert.equal(started.metadata.modelProfile, "balanced", "sin modelProfile en el run manda el default")
  assert.match(String(started.content), /\*\*Perfil:\*\* balanced/)

  const record = await waitForRun(ctx, "RUN-PROFILE-PREC")
  assert.equal(record.modelProfile, "balanced", "el perfil se persiste en el RunRecord")

  const created = (ctx as any).__created as any[]
  const modelOf = (taskId: string) => created.find((session) => session.metadata?.taskId === taskId)?.model
  assert.deepEqual(modelOf("P1"), { providerID: "opencode-go", id: "kimi-k2.7-code" }, "el perfil manda sobre el agente")
  assert.deepEqual(modelOf("P2"), { providerID: "custom", id: "manual" }, "el model de la tarea manda sobre el perfil")
  assert.deepEqual(modelOf("P3"), { providerID: "opencode-go", id: "glm-5.3-flash" })

  const status = await runStatus.execute({ runId: "RUN-PROFILE-PREC" })
  assert.match(String(status.content), /\*\*Perfil:\*\* balanced/, "run_status muestra el perfil")
  assert.equal(status.metadata.modelProfile, "balanced")
})

test("modelProfiles: un perfil inexistente se avisa y no aborta el run", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, {
    ...TOOL_SETTINGS,
    modelProfiles: resolveModelProfiles({}),
    defaultModelProfile: "balanced",
  })
  const orchestrate = tools.get("orchestrate")!

  const started = await orchestrate.execute(
    {
      objective: "perfil roto",
      runId: "RUN-PROFILE-BAD",
      modelProfile: "inexistente",
      tasks: [{ id: "B1", agent: "coder", objective: "sin perfil efectivo" }],
    },
    { sessionID: "ses_orq" },
  )
  assert.equal(started.metadata.ok, true, "un perfil inexistente nunca aborta el plan")
  assert.equal(started.metadata.modelProfile, undefined, "el run sigue sin perfil")
  assert.equal(started.metadata.modelProfileWarnings.length, 1)
  assert.match(String(started.content), /Avisos de `modelProfile`/)
  assert.match(String(started.content), /inexistente/)

  const record = await waitForRun(ctx, "RUN-PROFILE-BAD")
  assert.equal(record.status, "completed")
  assert.equal(record.modelProfile, undefined)

  const created = (ctx as any).__created as any[]
  assert.deepEqual(
    created[0].model,
    { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    "sin perfil cae al modelo declarado por el agente",
  )
})

test("modelProfiles: el modelProfile del run manda sobre el default y admite perfiles propios", async () => {
  const { ctx, tools } = makeToolCtx()
  await registerTools(ctx, {
    ...TOOL_SETTINGS,
    modelProfiles: resolveModelProfiles({ propio: { coder: "local/coder-x", qa: "local/qa-x" } }),
    defaultModelProfile: "balanced",
  })
  const orchestrate = tools.get("orchestrate")!

  const started = await orchestrate.execute(
    {
      objective: "perfil propio",
      runId: "RUN-PROFILE-RUN",
      modelProfile: "propio",
      tasks: [{ id: "C1", agent: "coder", objective: "usar el perfil del run" }],
    },
    { sessionID: "ses_orq" },
  )
  assert.equal(started.metadata.modelProfile, "propio", "el perfil del run gana al default")

  const record = await waitForRun(ctx, "RUN-PROFILE-RUN")
  assert.equal(record.modelProfile, "propio")

  const created = (ctx as any).__created as any[]
  assert.deepEqual(created[0].model, { providerID: "local", id: "coder-x" })
})

test("modelProfiles: la opción default aplica el orquestador vía agent.transform", async () => {
  const setup = (plugin as { setup: (context: PluginCtx) => Promise<() => Promise<void>> }).setup

  const ctx = makeCtx()
  ctx.options = { dashboardPort: 0, modelProfile: "high" }
  const dispose = await setup(ctx)
  try {
    const updates = (ctx as any).__agentUpdates as Array<{ id: string; model?: any }>
    assert.deepEqual(updates, [
      { id: "orquestador", model: { providerID: "opencode-go", id: "gemini-4-argon" } },
    ])
  } finally {
    await dispose()
  }
  assert.deepEqual(
    (ctx as any).__agentTransformDisposals,
    ["orquestador"],
    "el transform se libera al descargar el plugin",
  )

  // Un default inexistente no toca el catálogo de agentes.
  const missing = makeCtx()
  missing.options = { dashboardPort: 0, modelProfile: "no-existe" }
  const disposeMissing = await setup(missing)
  try {
    assert.deepEqual((missing as any).__agentUpdates, [], "sin perfil válido no hay transform")
  } finally {
    await disposeMissing()
  }

  // Sin modelProfile no se registra ningún transform.
  const plain = makeCtx()
  plain.options = { dashboardPort: 0 }
  const disposePlain = await setup(plain)
  try {
    assert.deepEqual((plain as any).__agentUpdates, [])
  } finally {
    await disposePlain()
  }
})

test("modelProfiles: el perfil viaja al frontmatter del plan", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plandocs-profile-"))
  try {
    const { ctx, tools } = makeToolCtx()
    await registerTools(ctx, {
      ...TOOL_SETTINGS,
      workdir: tmpDir,
      planDocs: "docs/plans",
      modelProfiles: resolveModelProfiles({}),
      defaultModelProfile: "low",
    })

    await tools.get("orchestrate")!.execute(
      {
        objective: "plan con perfil",
        runId: "RUN-PLAN-PROFILE",
        tasks: [{ id: "T1", agent: "qa", objective: "validar" }],
      },
      { sessionID: "ses_orq" },
    )
    await waitForRun(ctx, "RUN-PLAN-PROFILE")

    const content = fs.readFileSync(path.join(tmpDir, "docs/plans/RUN-PLAN-PROFILE.md"), "utf8")
    assert.match(content, /^modelProfile: low$/m, "el frontmatter guarda el perfil")
  } finally {
    cleanupDir(tmpDir)
  }

  const state = {
    workdir: "C:/repo",
    folder: "docs/plans",
    runId: "RUN-PLAN-NOPROFILE",
    objective: "sin perfil",
    baseBranch: "dev",
    startedAt: new Date().toISOString(),
    status: "running" as const,
    tasks: [],
    results: [],
    inFlight: [],
  }
  assert.ok(!renderPlanMarkdown(state).includes("modelProfile:"), "sin perfil no se escribe la clave")
  assert.match(renderPlanMarkdown({ ...state, modelProfile: "free" }), /^modelProfile: free$/m)
})
