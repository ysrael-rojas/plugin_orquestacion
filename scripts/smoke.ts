import assert from "node:assert/strict"
import { test } from "node:test"

import { buildTaskPrompt, extractReport } from "../src/contracts"
import { detectEngram } from "../src/engram"
import { getRun, recentRuns, saveRun } from "../src/history"
import { buildSessionPermissions } from "../src/permissions"
import { runOrchestration, planWaves } from "../src/runner"
import type { PluginCtx, TaskSpec } from "../src/types"

function makeCtx(options: { fail?: string[]; delayMs?: number } = {}): PluginCtx {
  let counter = 0
  const created: any[] = []
  const sessions = new Map<string, { input: any; prompt?: string; messages: any[] }>()
  const storage = new Map<string, any>()

  const ctx: PluginCtx = {
    options: {},
    location: { directory: "C:/repo" },
    session: {
      async create(input: any) {
        created.push(input)
        const id = `ses_test_${++counter}`
        sessions.set(id, { input, messages: [] })
        return { id }
      },
      async prompt({ sessionID, text }: any) {
        sessions.get(sessionID)!.prompt = text
      },
      async wait() {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      },
      async context({ sessionID }: any) {
        const session = sessions.get(sessionID)!
        const taskId = session.input?.metadata?.taskId ?? "?"
        const shouldFail = (options.fail ?? []).includes(taskId)
        const text = shouldFail
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
  assert.deepEqual(extractReport('{"a":1}'), { a: 1 })
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
