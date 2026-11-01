import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { buildTaskPrompt, extractReport } from "../src/contracts"
import { detectEngram } from "../src/engram"
import { getRun, pruneRuns, recentRuns, saveRun } from "../src/history"
import { buildSessionPermissions } from "../src/permissions"
import { renderPlanMarkdown, sanitizePlanDocsFolder, writePlanDocs } from "../src/plandocs"
import { runOrchestration, planWaves } from "../src/runner"
import plugin from "../src/index"
import { registerTools } from "../src/tools"
import { registerSkills } from "../src/skills"
import type { PluginCtx, TaskSpec } from "../src/types"

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
