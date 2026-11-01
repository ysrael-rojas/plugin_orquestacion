import assert from "node:assert/strict"
import { test } from "node:test"

import { buildTaskPrompt, extractReport } from "../src/contracts"
import { detectEngram } from "../src/engram"
import { getRun, recentRuns, saveRun } from "../src/history"
import { buildSessionPermissions } from "../src/permissions"
import { runOrchestration, planWaves } from "../src/runner"
import type { PluginCtx, TaskSpec } from "../src/types"

function makeCtx(options: { fail?: string[]; delayMs?: number; noReport?: string[] } = {}): PluginCtx {
  let counter = 0
  const created: any[] = []
  const prompts: Array<{ taskId: string; text: string }> = []
  const worktreesCreated: any[] = []
  const worktreesRemoved: any[] = []
  const permissionAsserts: any[] = []
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
