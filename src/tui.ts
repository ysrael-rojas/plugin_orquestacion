/**
 * Parte TUI del plugin Aiapaec.
 *
 * Registra el comando `aiapaec` (paleta y slash) que lista los runs de
 * orquestación agrupando las sesiones hijas por `runId` (metadata de sesión).
 * Usa solo diálogos del TUI: no renderiza JSX, así que no depende de OpenTUI.
 */
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "aiapaec.tui",
  setup(context: any) {
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "aiapaec.runs",
          title: "Aiapaec: runs de orquestación",
          group: "Aiapaec",
          palette: true,
          slash: { name: "aiapaec" },
          run: async () => {
            await showRuns(context)
          },
        },
      ],
      bindings: ["aiapaec.runs"],
    }))
  },
})

interface SessionLike {
  id: string
  title?: string
  agent?: string
  metadata?: Record<string, any>
  time?: { created?: number }
}

async function showRuns(context: any): Promise<void> {
  const sessions: SessionLike[] = (context.data.session.list() ?? []).filter(
    (session: SessionLike) => session?.metadata?.orquestacion === true,
  )

  if (sessions.length === 0) {
    await context.ui.dialog.alert({
      title: "Aiapaec",
      message: "No hay runs de orquestación registrados en esta ubicación.",
    })
    return
  }

  const runs = new Map<string, SessionLike[]>()
  for (const session of sessions) {
    const runId = String(session.metadata?.runId ?? "sin-run")
    const tasks = runs.get(runId) ?? []
    tasks.push(session)
    runs.set(runId, tasks)
  }

  const options = [...runs.entries()]
    .sort((left, right) => newest(right[1]) - newest(left[1]))
    .map(([runId, tasks]) => ({
      title: `${runId} · ${aggregate(context, tasks)} · ${tasks.length} tarea(s)`,
      value: runId,
    }))

  const selected = await context.ui.dialog.select({
    title: "Aiapaec — runs",
    options,
  })
  if (!selected) return

  const tasks = (runs.get(selected) ?? []).slice().sort((a, b) => created(a) - created(b))
  const objective = tasks[0]?.metadata?.objective
  const lines = tasks.map(
    (task) =>
      `• ${task.metadata?.taskId ?? "?"} · ${task.agent ?? "?"} · ${sessionState(context, task)} · ${task.title ?? ""}`,
  )

  await context.ui.dialog.alert({
    title: `Run ${selected}`,
    message: [objective ? `Objetivo: ${objective}` : "", "", ...lines].join("\n"),
  })
}

function created(session: SessionLike): number {
  return session.time?.created ?? 0
}

function newest(tasks: SessionLike[]): number {
  return Math.max(...tasks.map(created))
}

function aggregate(context: any, tasks: SessionLike[]): string {
  const states = tasks.map((task) => sessionState(context, task))
  if (states.some((state) => /busy|running|pending/i.test(state))) return "en curso"
  if (states.some((state) => /error|failed/i.test(state))) return "con fallos"
  if (states.some((state) => /unknown/i.test(state))) return "desconocido"
  return "completado"
}

function sessionState(context: any, session: SessionLike): string {
  try {
    const status = context.data.session.status(session.id)
    if (typeof status === "string") return status
    if (status && typeof status === "object") return String(status.type ?? status.state ?? "unknown")
    return "idle"
  } catch {
    return "unknown"
  }
}
