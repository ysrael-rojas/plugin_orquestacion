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
  const runs = await scanAllRuns(ctx)
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  return runs.slice(0, limit)
}

/** Elimina los runs más antiguos, conservando los `keep` más recientes. */
export async function pruneRuns(ctx: PluginCtx, keep = 50): Promise<number> {
  const runs = await scanAllRuns(ctx)
  if (runs.length <= keep) return 0

  runs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
  const toRemove = runs.slice(0, runs.length - keep)
  let removed = 0
  for (const run of toRemove) {
    try {
      await ctx.storage.remove(`${PREFIX}${run.runId}`)
      removed++
    } catch {
      // best-effort: si falla, se reintenta en la próxima limpieza
    }
  }
  return removed
}

async function scanAllRuns(ctx: PluginCtx, cap = 1000): Promise<RunRecord[]> {
  const runs: RunRecord[] = []
  let cursor: string | undefined

  for (let page = 0; page < 20; page++) {
    const result = await ctx.storage.scan({
      prefix: PREFIX,
      limit: 200,
      ...(cursor ? { after: cursor } : {}),
    })

    for (const entry of result.entries) {
      const run = entry.value as RunRecord
      if (run?.runId) runs.push(run)
    }

    cursor = result.next
    if (!cursor || runs.length >= cap) break
  }

  return runs
}
