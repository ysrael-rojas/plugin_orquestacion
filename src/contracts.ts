import type { TaskSpec } from "./types"

/** Contrato A: tarea asignada del orquestador al subagente. */
export function buildTaskContract(task: TaskSpec, baseBranch: string) {
  return {
    task_id: task.id,
    target_agent: task.agent,
    objective: task.objective,
    branch: task.branch ?? `feat/${task.id}`,
    base_branch: baseBranch,
    scope: task.scope ?? {},
    context_references: task.context ?? {},
    permissions: task.permissions ?? {},
  }
}

export interface PromptOptions {
  task: TaskSpec
  baseBranch: string
  runObjective: string
  /** Directorio del worktree aislado donde corre la tarea (si aplica). */
  worktreeDirectory?: string
  /** Resultados upstream con worktree, para que el subagente sepa dónde revisarlos. */
  upstream?: Array<{ taskId: string; worktreeDirectory?: string; branch?: string }>
}

/** Construye el prompt que recibe el subagente: contrato + flujo + contrato B. */
export function buildTaskPrompt(options: PromptOptions): string {
  const { task, baseBranch, runObjective, worktreeDirectory, upstream } = options
  const contract = buildTaskContract(task, baseBranch)
  const contractJSON = JSON.stringify(contract, null, 2)

  const reportShape = JSON.stringify(
    {
      task_id: task.id,
      status: "success",
      summary: "Resumen breve de lo realizado",
      artifacts: {
        modified_files: [] as string[],
        git_branch: contract.branch,
        last_commit_hash: "",
      },
      next_recommended_action: "pass_to_qa",
    },
    null,
    2,
  )

  const lines: string[] = [
    `# Tarea asignada — ${task.id}`,
    "",
    `Objetivo global de la orquestación: **${runObjective}**`,
    "",
    "Formas parte de una orquestación de subagentes (Aiapaec). Tu trabajo se limita a la tarea del contrato.",
    "",
    "## Contrato de entrada",
    "```json",
    contractJSON,
    "```",
    "",
    "## Flujo de trabajo",
  ]

  const worktreeNote = worktreeDirectory
    ? ` Trabajas en el **worktree aislado** \`${worktreeDirectory}\`; todas tus operaciones de archivos y git deben ocurrir dentro de ese directorio.`
    : ""

  lines.push(
    `1. Si tu tarea incluye cambios de código, trabaja en la rama \`${contract.branch}\` derivada de \`${baseBranch}\`. Crea la rama si no existe.${worktreeNote}`,
    "2. Respeta el scope: no modifiques archivos prohibidos. No toques archivos fuera de `allowed_files`.",
    "3. No hagas merge, no hagas push a la rama base y no despliegues a producción: eso requiere aprobación humana.",
    "4. Si necesitas contexto de memoria y tienes disponibles las herramientas `mem_*` (Engram), úsalas.",
  )

  if (upstream && upstream.some((entry) => entry.worktreeDirectory)) {
    lines.push("", "## Trabajo previo en worktrees")
    for (const entry of upstream) {
      if (!entry.worktreeDirectory) continue
      const branch = entry.branch ? ` (rama \`${entry.branch}\`)` : ""
      lines.push(`- **${entry.taskId}**: \`${entry.worktreeDirectory}\`${branch}`)
    }
    lines.push("Si necesitas revisar ese trabajo, hazlo sobre esa copia aislada; no la modifiques.")
  }

  lines.push(
    "",
    "## Contrato de reporte (obligatorio)",
    "Termina tu respuesta con un ÚNICO bloque ```json con esta forma exacta:",
    "```json",
    reportShape,
    "```",
    "No agregues código ni texto después del bloque JSON.",
  )

  return lines.join("\n")
}

/** Extrae el reporte JSON de la respuesta del subagente (tolerante). */
export function extractReport(text: string): unknown | undefined {
  if (!text) return undefined

  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced) {
    const parsed = tryParse(fenced[1]!)
    if (parsed !== undefined) return parsed
  }

  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first >= 0 && last > first) {
    const parsed = tryParse(text.slice(first, last + 1))
    if (parsed !== undefined) return parsed
  }

  return undefined
}

function tryParse(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw.trim())
  } catch {
    return undefined
  }
}
