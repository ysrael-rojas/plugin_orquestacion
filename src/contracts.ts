import type { QaLevel, TaskSpec } from "./types"

/** Niveles válidos de exigencia de QA, de menos a más profundo. */
export const QA_LEVELS: readonly QaLevel[] = ["L1", "L2", "L3"]

/** Nivel que se aplica cuando la tarea no declara `qaLevel`. */
export const DEFAULT_QA_LEVEL: QaLevel = "L2"

/**
 * Definición operativa de cada nivel. Se inyecta en el prompt de las tareas
 * con agente `qa` para que el subagente sepa qué evidencia se le exige.
 */
export const QA_LEVEL_GUIDE: Record<QaLevel, string> = {
  L1: "smoke: ejecuta `pnpm test` y reporta pass/fail con evidencia del comando; nada más.",
  L2: "estándar: valida contra el spec del contrato con evidencia (comando + salida, `archivo:línea` en desviaciones).",
  L3: "forense: L2 + verificación de supuestos técnicos contra fuentes reales (p. ej. nombres de eventos/APIs contra los `.d.ts` del SDK, comportamientos no cubiertos por tests mockeados).",
}

export function isQaLevel(value: unknown): value is QaLevel {
  return value === "L1" || value === "L2" || value === "L3"
}

/** Nivel efectivo: el declarado si es válido, si no `DEFAULT_QA_LEVEL`. */
export function resolveQaLevel(task: Pick<TaskSpec, "qaLevel">): QaLevel {
  return isQaLevel(task.qaLevel) ? task.qaLevel : DEFAULT_QA_LEVEL
}

export interface QaLevelNormalization {
  /** Copia de las tareas con el `qaLevel` declarado válido (o L2 si era inválido). */
  tasks: TaskSpec[]
  /** Avisos de valores inválidos que cayeron a `DEFAULT_QA_LEVEL`. */
  warnings: string[]
}

/**
 * Normaliza el `qaLevel` declarado en cada tarea. Política elegida: un valor
 * inválido **no aborta el plan**, cae a `L2` con un aviso visible en la
 * respuesta de `aiapaec_orchestrate` y en `metadata.qaLevelWarnings`.
 */
export function normalizeQaLevels(tasks: readonly TaskSpec[]): QaLevelNormalization {
  const warnings: string[] = []
  const normalized = tasks.map((task) => {
    if (task.qaLevel === undefined || isQaLevel(task.qaLevel)) return task
    warnings.push(
      `qaLevel inválido en la tarea ${task.id}: ${JSON.stringify(task.qaLevel)}; se usa ${DEFAULT_QA_LEVEL}. Niveles válidos: ${QA_LEVELS.join(", ")}.`,
    )
    return { ...task, qaLevel: DEFAULT_QA_LEVEL }
  })

  return { tasks: normalized, warnings }
}

/**
 * Normaliza las skills declaradas para una tarea: solo strings no vacíos, sin
 * duplicados (comparación sin distinguir mayúsculas) y conservando el orden.
 * Una forma inesperada (no array) devuelve lista vacía: nunca aborta el plan.
 */
export function normalizeSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const skills: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") continue
    const skill = entry.trim()
    if (!skill) continue
    const key = skill.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    skills.push(skill)
  }
  return skills
}

/** Contrato A: tarea asignada del orquestador al subagente. */
export function buildTaskContract(task: TaskSpec, baseBranch: string) {
  // El nivel solo viaja en el contrato de las tareas de QA o cuando la tarea
  // lo declara explícitamente (evita ruido en tareas de coder/explorador).
  const qaLevel = task.agent === "qa" || task.qaLevel !== undefined ? resolveQaLevel(task) : undefined

  return {
    task_id: task.id,
    target_agent: task.agent,
    objective: task.objective,
    branch: task.branch ?? `feat/${task.id}`,
    base_branch: baseBranch,
    scope: task.scope ?? {},
    context_references: task.context ?? {},
    permissions: task.permissions ?? {},
    ...(qaLevel ? { qa_level: qaLevel } : {}),
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
    ? ` Trabajas en el **worktree aislado** \`${worktreeDirectory}\`; todas tus operaciones de archivos y git deben ocurrir dentro de ese directorio. Los worktrees no heredan \`node_modules\` (está en .gitignore): si necesitas ejecutar pruebas o scripts con dependencias, ejecuta \`pnpm install\` dentro del worktree antes.`
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

  // Nivel de QA: solo aplica a tareas de validación (agente `qa`). Sin
  // `qaLevel` declarado se asume L2 (estándar).
  if (task.agent === "qa") {
    const qaLevel = resolveQaLevel(task)
    lines.push(
      "",
      `## Nivel de QA — ${qaLevel}`,
      "",
      QA_LEVEL_GUIDE[qaLevel],
      "",
      `Niveles válidos: ${QA_LEVELS.join(" · ")} (default ${DEFAULT_QA_LEVEL}). Reporta la evidencia exigida por el nivel; si el contrato trae más trabajo del que el nivel permite evidenciar, dilo en el resumen.`,
    )
  }

  // Skills declaradas por el orquestador: deterministas y por tarea. Si la
  // skill no existe en este entorno, se aplica su disciplina igualmente.
  const skills = normalizeSkills(task.skills)
  if (skills.length > 0) {
    lines.push(
      "",
      "## Skills a aplicar",
      "",
      `Skills declaradas para esta tarea: ${skills.map((skill) => `\`${skill}\``).join(", ")}.`,
      "",
      "Si una skill está disponible en este entorno, invócala; si no, aplica su disciplina igualmente (una skill ausente no justifica abortar la tarea).",
    )
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

  // El prompt exige el reporte en el ÚLTIMO bloque ```json; el contrato de
  // entrada es el primero. Se recorre desde el final y se descartan los
  // bloques que no tienen forma de reporte (status/task_id).
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)]
  for (let index = fenced.length - 1; index >= 0; index--) {
    const parsed = tryParse(fenced[index]![1]!)
    if (isReport(parsed)) return parsed
  }

  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first >= 0 && last > first) {
    const parsed = tryParse(text.slice(first, last + 1))
    if (isReport(parsed)) return parsed
  }

  return undefined
}

function isReport(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.status === "string" || typeof record.task_id === "string"
}

function tryParse(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw.trim())
  } catch {
    return undefined
  }
}
