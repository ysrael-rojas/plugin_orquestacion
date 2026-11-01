import type { PluginCtx, RunRecord } from "./types"

const PREFIX = "runs/"

/** Guarda (o actualiza) el registro de una orquestación en el storage del plugin. */
export async function saveRun(ctx: PluginCtx, record: RunRecord): Promise<void> {
  await ctx.storage.set(`${PREFIX}${record.runId}`, record as any)
}

/** Recupera un run por ID (permite retomar el reporte aunque se pierda el resultado del tool). */
export async function getRun(ctx: PluginCtx, runId: string): Promise<RunRecord | undefined> {
  const value = await ctx.storage.get(`${PREFIX}${runId}`)
  return value && typeof value === "object" ? (value as RunRecord) : undefined
}

/** Devuelve las últimas orquestaciones guardadas (más recientes primero). */
export async function recentRuns(ctx: PluginCtx, limit = 10): Promise<RunRecord[]> {
  const page = await ctx.storage.scan({ prefix: PREFIX, limit: 100 })
  const runs = page.entries
    .map((entry) => entry.value as RunRecord)
    .filter((run): run is RunRecord => Boolean(run?.runId))

  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  return runs.slice(0, limit)
}
