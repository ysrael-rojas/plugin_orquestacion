import assert from "node:assert/strict"
import fs from "node:fs"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { buildTaskPrompt, extractReport } from "../src/contracts"
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
import { DASHBOARD_REFRESH_MS, renderDashboardHtml } from "../src/dashboard-html"
import { buildDashboardView, escapeHtml } from "../src/dashboard-view"
import { detectEngram } from "../src/engram"
import { getRun, pruneRuns, recentRuns, saveRun } from "../src/history"
import { buildSessionPermissions } from "../src/permissions"
import { renderPlanMarkdown, sanitizePlanDocsFolder, writePlanDocs } from "../src/plandocs"
import { runOrchestration, planWaves } from "../src/runner"
import plugin from "../src/index"
import { registerTools } from "../src/tools"
import { registerSkills } from "../src/skills"
import type { PluginCtx, RunRecord, TaskSpec } from "../src/types"

function makeCtx(options: { fail?: string[]; delayMs?: number; noReport?: string[] } = {}): PluginCtx {
  let counter = 0
  const created: any[] = []
  const prompts: Array<{ taskId: string; text: string }> = []
  const worktreesCreated: any[] = []
  const worktreesRemoved: any[] = []
  const permissionAsserts: any[] = []
  const interrupts: any[] = []
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
    },
    command: { async transform() { return { dispose: async () => {} } } },
    tool: { async transform() { return { dispose: async () => {} } } },
  }

  ;(ctx as any).__created = created
  ;(ctx as any).__prompts = prompts
  ;(ctx as any).__permissions = permissionAsserts
  ;(ctx as any).__interrupts = interrupts
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

  for (let i = 0; i < 3; i++) {
    await waitForRun(ctx, `RUN-E2E-${i}`)
  }

  const runs = await recentRuns(ctx, 10)
  assert.equal(runs.length, 2, "con runHistory=2 deben quedar los dos runs más recientes")
  assert.equal(runs[0]!.runId, "RUN-E2E-2")
  assert.equal(runs[1]!.runId, "RUN-E2E-1")
})

test("skills: registra grilling y grill-me desde .agents/skills/", async () => {
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
  assert.deepEqual(ids, ["grill-me", "grilling"])

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
    inFlight: ["T2"],
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

test("dashboard: la columna tokens/costo solo aparece si hay datos", () => {
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
  assert.ok(!html.includes("<th>Tokens / costo</th>"), "sin datos no debe existir la columna")
  assert.match(html, /<details class="run-card/, "el historial va plegado en details")

  const conTokens = renderDashboardHtml(buildDashboardView(dashboardRuns()))
  assert.ok(conTokens.includes("<th>Tokens / costo</th>"), "con datos sí se muestra la columna")
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
    assert.match(page, /Aiapaec · orquestaciones en vivo/)
    assert.match(page, /127\.0\.0\.1/)

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

  assert.equal(view.version, 2, "el contrato de /api/state sube a v2")
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
    assert.equal(state.version, 2)
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
