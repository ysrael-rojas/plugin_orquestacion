#!/usr/bin/env node
/**
 * Cierre de run: merge -> plan docs -> pruebas -> push -> limpieza -> (restart).
 *
 * Uso:
 *   pnpm run cierre -- <rama> [--restart] [--run-id <runId>]
 *
 * Diseño: las funciones puras (validación, mensajes, detección de runId y de
 * plan) se exportan para poder probarlas desde `scripts/smoke.ts` sin tocar el
 * repositorio. El wrapper CLI solo corre cuando el archivo es el entrypoint.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Ramas sobre las que el script se niega a correr. */
export const PROTECTED_BRANCHES = Object.freeze(["main", "dev", "master"])

/** Rama de integración por defecto. */
export const BASE_BRANCH = "dev"

/** Carpeta por defecto de los documentos de plan. */
export const DEFAULT_PLAN_FOLDER = "docs/plans"

const USAGE = [
  "Uso: pnpm run cierre -- <rama> [--restart] [--run-id <runId>]",
  "",
  "  <rama>            Rama local ya aprobada por el humano (no main/dev/master).",
  "  --run-id <id>     RunId para el mensaje de merge y el plan (si no se detecta).",
  "  --restart         Reinicia el servicio de OpenCode al final (corta la sesión).",
  "  --help            Muestra esta ayuda.",
].join("\n")

const RUN_TOKEN = /^[A-Z][A-Z0-9]*$/
const DIGITS = /^\d+$/

/**
 * Parsea los argumentos del CLI sin tocar el entorno.
 * @param {string[]} argv
 * @returns {{ branch: string, restart: boolean, runId: string | null, help: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : []
  const state = { branch: "", restart: false, runId: null, help: false, errors: [] }
  const positional = []
  let literal = false

  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (typeof raw !== "string" || raw.trim() === "") continue
    const arg = raw.trim()

    if (literal) {
      positional.push(arg)
      continue
    }
    if (arg === "--") {
      literal = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      state.help = true
      continue
    }
    if (arg === "--restart") {
      state.restart = true
      continue
    }
    if (arg === "--run-id") {
      const value = args[i + 1]
      if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) {
        state.errors.push("La opción --run-id necesita un valor (ej. --run-id RUN-TASK-101).")
      } else {
        state.runId = value.trim()
        i++
      }
      continue
    }
    if (arg.startsWith("--run-id=")) {
      const value = arg.slice("--run-id=".length).trim()
      if (value === "") state.errors.push("La opción --run-id necesita un valor (ej. --run-id=RUN-TASK-101).")
      else state.runId = value
      continue
    }
    if (arg.startsWith("-")) {
      state.errors.push(`Opción desconocida: ${arg}`)
      continue
    }
    positional.push(arg)
  }

  if (positional.length > 0) state.branch = positional[0]
  if (positional.length > 1) {
    state.errors.push(`Argumento inesperado: ${positional.slice(1).join(" ")}`)
  }
  return state
}

/**
 * Valida que la rama se pueda cerrar. Devuelve `{ ok, error }`.
 * @param {string} branch
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateBranch(branch) {
  const name = typeof branch === "string" ? branch.trim() : ""
  if (name === "") {
    return { ok: false, error: "Falta la rama a cerrar. Uso: pnpm run cierre -- <rama> [--restart]" }
  }
  const lower = name.toLowerCase()
  if (PROTECTED_BRANCHES.includes(lower)) {
    return { ok: false, error: `La rama "${name}" está protegida: el cierre corre sobre una rama de tarea.` }
  }
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) {
    return { ok: false, error: `Nombre de rama inválido: "${name}".` }
  }
  if (/[\s~^:?*[\]\\]|\.\./.test(name)) {
    return { ok: false, error: `Nombre de rama inválido: "${name}".` }
  }
  return { ok: true }
}

/**
 * Intenta deducir el runId desde el nombre de la rama.
 * Ej: "feat/RUN-ACTIVITY-2" -> "RUN-ACTIVITY-2"; "feat/TASK-RUNHISTORY" -> "TASK-RUNHISTORY";
 * "feat/cierre-script" -> null (sin tokens en mayúsculas).
 * @param {string} branch
 * @returns {string | null}
 */
export function runIdFromBranch(branch) {
  if (typeof branch !== "string") return null
  const name = branch
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
  if (name === "") return null
  const tail = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name
  const tokens = tail.split(/[-_]/).filter(Boolean)

  const kept = []
  for (const token of tokens) {
    if (RUN_TOKEN.test(token)) kept.push(token)
    else if (kept.length > 0 && DIGITS.test(token)) kept.push(token)
    else if (kept.length > 0) break
  }

  const runIndex = kept.indexOf("RUN")
  const picked = runIndex >= 0 ? kept.slice(runIndex) : kept
  return picked.length > 0 ? picked.join("-") : null
}

/**
 * Construye el mensaje del merge `--no-ff`.
 * @param {string} branch
 * @param {string | null} [runId]
 * @returns {string}
 */
export function buildMergeMessage(branch, runId) {
  const name = typeof branch === "string" ? branch.trim() : ""
  const id = typeof runId === "string" ? runId.trim() : ""
  return id === "" ? `merge: ${name}` : `merge: ${name} (${id})`
}

/**
 * Ruta relativa del documento de plan, o `null` si el runId no es seguro.
 * @param {string | null} runId
 * @param {string} [folder]
 * @returns {string | null}
 */
export function planDocPath(runId, folder = DEFAULT_PLAN_FOLDER) {
  if (typeof runId !== "string") return null
  const id = runId.trim()
  if (id === "" || id === "." || id === ".." || /[\\/]/.test(id)) return null
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null
  const dir = typeof folder === "string" && folder.trim() !== "" ? folder.trim() : DEFAULT_PLAN_FOLDER
  const normalized = dir.replace(/\\/g, "/").replace(/\/+$/, "")
  if (normalized === "" || normalized.split("/").includes("..")) return null
  return `${normalized}/${id}.md`
}

/**
 * Analiza `git status --porcelain` y devuelve la lista de bloqueos para el
 * cierre. El documento de plan del run se tolera sin trackear: se commitea en
 * el paso (c). Cualquier otro cambio (modificado, staged o untracked) bloquea.
 * @param {string | null | undefined} porcelain
 * @param {string | null} [planPath]
 * @returns {string[]}
 */
export function workingTreeBlockers(porcelain, planPath = null) {
  const allowed = typeof planPath === "string" ? planPath.replace(/\\/g, "/").replace(/^\.\//, "") : null
  const blockers = []
  for (const raw of String(porcelain ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "")
    if (line.trim() === "") continue
    const untracked = line.startsWith("??")
    const pathPart = line.slice(3)
    const target = (pathPart.includes(" -> ") ? pathPart.split(" -> ").pop() : pathPart)
      .replace(/\\/g, "/")
      .replace(/^"|"$/g, "")
      .replace(/^\.\//, "")
    if (untracked && allowed !== null) {
      const dir = target.replace(/\/+$/, "")
      if (target === allowed || (dir !== "" && allowed.startsWith(`${dir}/`))) continue
    }
    blockers.push(line.trim())
  }
  return blockers
}

/**
 * ¿La rama ya está mergeada en la base? Si HEAD de la rama coincide con el
 * merge-base, la rama no aporta commits nuevos.
 * @param {{ branchHead?: string, mergeBase?: string }} input
 * @returns {boolean}
 */
export function isAlreadyMerged(input) {
  const branchHead = typeof input?.branchHead === "string" ? input.branchHead.trim() : ""
  const mergeBase = typeof input?.mergeBase === "string" ? input.mergeBase.trim() : ""
  return branchHead !== "" && mergeBase !== "" && branchHead === mergeBase
}

/** Formatea un fallo de comando con su salida, recortada. */
function detail(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`.trim()
  if (text === "") return ""
  const lines = text.split(/\r?\n/).filter(Boolean)
  return `\n   ${lines.slice(0, 8).join("\n   ")}`
}

/**
 * Lanza un proceso. En Windows, `pnpm` y `opencode` son shims `.cmd` y exigen
 * `shell: true`; para no concatenar argumentos con el shell (DEP0190) se pasa
 * una única línea de comando armada solo con tokens constantes del script.
 */
function spawnCommand(cmd, args, cwd, stdio) {
  const useShell = process.platform === "win32" && (cmd === "pnpm" || cmd === "opencode")
  if (useShell) {
    return spawnSync([cmd, ...args].join(" "), { cwd, stdio, shell: true, encoding: "utf8" })
  }
  return spawnSync(cmd, args, { cwd, stdio, encoding: "utf8" })
}

/** Ejecuta un comando capturando salida. */
function capture(cmd, args, cwd) {
  const result = spawnCommand(cmd, args, cwd, "pipe")
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
    error: result.error ? String(result.error.message) : "",
  }
}

/** Ejecuta un comando con la salida en vivo (pruebas, restart). */
function inherit(cmd, args, cwd) {
  const result = spawnCommand(cmd, args, cwd, "inherit")
  return { ok: result.status === 0, status: result.status, error: result.error ? String(result.error.message) : "" }
}

function ok(message) {
  console.log(`✅ ${message}`)
}

function fail(message) {
  console.error(`❌ ${message}`)
}

function info(message) {
  console.log(`🔄 ${message}`)
}

/** Nombre del archivo que puede ejecutar el CLI. */
export const SCRIPT_NAME = "cierre.mjs"

/**
 * ¿El proceso se lanzó con este script? Compara la ruta, pero además exige el
 * nombre del archivo: cuando `scripts/smoke.ts` se bundlea con esbuild,
 * `import.meta.url` apunta al bundle (`smoke.mjs`) y el guard no debe dispararse.
 * @param {string} scriptPath
 * @param {string} argv1
 * @param {string} [expectedName]
 * @returns {boolean}
 */
export function isEntrypoint(scriptPath, argv1, expectedName = SCRIPT_NAME) {
  if (typeof scriptPath !== "string" || typeof argv1 !== "string") return false
  if (scriptPath === "" || argv1 === "") return false
  try {
    const script = path.resolve(scriptPath)
    const entry = path.resolve(argv1)
    if (script !== entry) return false
    return path.basename(entry).toLowerCase() === expectedName
  } catch {
    return false
  }
}

/**
 * Flujo completo de cierre. No hace push ni merge por sí mismo: todo pasa por
 * `git` en el repositorio actual, con los rieles del contrato.
 * @param {{ argv?: string[], cwd?: string, log?: { ok: Function, fail: Function, info: Function } }} [options]
 * @returns {number} código de salida
 */
export function runCierre(options = {}) {
  const write = options.log ?? { ok, fail, info }
  const parsed = parseArgs(options.argv ?? process.argv.slice(2))

  if (parsed.help) {
    console.log(USAGE)
    return 0
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) write.fail(error)
    console.error(`\n${USAGE}`)
    return 1
  }
  const validation = validateBranch(parsed.branch)
  if (!validation.ok) {
    write.fail(validation.error)
    return 1
  }

  const branch = parsed.branch.trim()
  const cwd = options.cwd ?? process.cwd()
  const runId = parsed.runId ?? runIdFromBranch(branch)
  const plan = planDocPath(runId)
  info(`Cierre de run: "${branch}" -> ${BASE_BRANCH}`)

  // (a) Rieles de seguridad.
  const branchRef = capture("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd)
  if (!branchRef.ok || branchRef.stdout === "") {
    write.fail(`La rama local "${branch}" no existe.`)
    return 1
  }
  const branchSha = branchRef.stdout.split(/\r?\n/)[0]
  write.ok(`La rama "${branch}" existe (${branchSha.slice(0, 7)})`)

  const status = capture("git", ["status", "--porcelain", "-uall"], cwd)
  if (!status.ok) {
    write.fail(`No se pudo leer el estado del repositorio.${detail(status)}`)
    return 1
  }
  const blockers = workingTreeBlockers(status.stdout, plan)
  if (blockers.length > 0) {
    write.fail(`El working tree tiene cambios sin commitear: ${blockers.slice(0, 5).join(" | ")}`)
    return 1
  }
  write.ok("Working tree limpio")

  const current = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  const currentBranch = current.stdout.split(/\r?\n/)[0]
  if (currentBranch !== BASE_BRANCH) {
    const checkout = capture("git", ["checkout", BASE_BRANCH], cwd)
    if (!checkout.ok) {
      write.fail(
        `No se pudo cambiar a "${BASE_BRANCH}" (¿está abierta en otro worktree?).${detail(checkout)}`,
      )
      return 1
    }
    write.ok(`Checkout a ${BASE_BRANCH}`)
  } else {
    write.ok(`HEAD ya está en ${BASE_BRANCH}`)
  }

  const mergeBase = capture("git", ["merge-base", BASE_BRANCH, branch], cwd)
  if (!mergeBase.ok) {
    write.fail(`No se pudo calcular el merge-base con ${BASE_BRANCH}.${detail(mergeBase)}`)
    return 1
  }
  if (isAlreadyMerged({ branchHead: branchSha, mergeBase: mergeBase.stdout })) {
    write.fail(`La rama "${branch}" ya está mergeada en ${BASE_BRANCH}: no hay nada que cerrar.`)
    return 1
  }
  write.ok(`"${branch}" aporta commits nuevos a ${BASE_BRANCH}`)

  const preMerge = capture("git", ["rev-parse", "HEAD"], cwd)
  if (!preMerge.ok) {
    write.fail(`No se pudo capturar el SHA previo al merge.${detail(preMerge)}`)
    return 1
  }
  const preMergeSha = preMerge.stdout.split(/\r?\n/)[0]

  // (b) Merge --no-ff con mensaje autogenerado.
  const message = buildMergeMessage(branch, runId)
  const merge = capture("git", ["merge", "--no-ff", "-m", message, branch], cwd)
  if (!merge.ok) {
    write.fail(`El merge falló (posible conflicto). Resuélvelo a mano y reintenta.${detail(merge)}`)
    return 1
  }
  write.ok(`Merge creado: ${message}`)

  // (c) Documento de plan sin trackear.
  if (plan === null) {
    if (runId) write.info("RunId no utilizable como nombre de archivo: se omite el documento de plan.")
  } else {
    const absolutePlan = path.resolve(cwd, plan)
    if (fs.existsSync(absolutePlan)) {
      const tracked = capture("git", ["ls-files", "--error-unmatch", plan], cwd)
      if (tracked.ok) {
        write.ok(`El plan ${plan} ya estaba trackeado`)
      } else {
        const add = capture("git", ["add", plan], cwd)
        const commit = add.ok
          ? capture("git", ["commit", "-m", `docs: plan de ${runId}`], cwd)
          : { ok: false }
        if (!add.ok || !commit.ok) {
          write.fail(`No se pudo commitear ${plan}.${detail(add.ok ? commit : add)}`)
          return 1
        }
        write.ok(`Plan ${plan} commiteado (docs: plan de ${runId})`)
      }
    } else {
      write.info(`Sin documento de plan en ${plan}: se omite`)
    }
  }

  // (d) Pruebas: sin verdes no hay push.
  info("Ejecutando pnpm test…")
  const tests = inherit("pnpm", ["test"], cwd)
  if (!tests.ok) {
    const rollback = capture("git", ["reset", "--hard", preMergeSha], cwd)
    write.fail("pnpm test falló: no se hace push.")
    if (rollback.ok) write.ok(`Merge deshecho en ${BASE_BRANCH} (vuelta a ${preMergeSha.slice(0, 7)})`)
    else write.fail(`No se pudo deshacer el merge; revisa a mano (${preMergeSha}).${detail(rollback)}`)
    return 1
  }
  write.ok("pruebas en verde")

  // (e) Push a la rama de integración.
  const push = capture("git", ["push", "origin", BASE_BRANCH], cwd)
  if (!push.ok) {
    write.fail(
      `El push a origin/${BASE_BRANCH} falló. El merge queda local y las pruebas pasaron: reintenta el push.${detail(push)}`,
    )
    return 1
  }
  write.ok(`push origin ${BASE_BRANCH}`)

  // (f) Limpieza de la rama de tarea.
  const remove = capture("git", ["branch", "-d", branch], cwd)
  if (remove.ok) write.ok(`Rama local "${branch}" eliminada`)
  else write.info(`La rama "${branch}" no se pudo borrar (¿abierta en otro worktree?): bórrala a mano.`)

  // (g) Restart opcional: última acción, corta la conexión del invocador.
  if (parsed.restart) {
    info("Reiniciando el servicio de OpenCode (la conexión del invocador se cortará)…")
    inherit("opencode", ["service", "restart"], cwd)
  }

  console.log("🎉 Cierre completado")
  return 0
}

const entry = process.argv[1]
if (isEntrypoint(fileURLToPath(import.meta.url), entry)) {
  process.exitCode = runCierre()
}
