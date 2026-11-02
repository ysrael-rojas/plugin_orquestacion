#!/usr/bin/env node
/**
 * `pnpm run dashboard`: abre el dashboard de Aiapaec en una ventana de app.
 *
 * Qué es una "ventana de app": Edge/Chrome aceptan `--app=<url>` y muestran la
 * página sin barra de direcciones, pestañas ni extensiones (in-app browser).
 *
 * Orden de intentos:
 *   1. Microsoft Edge con `--app=` (instalación habitual en Windows).
 *   2. Google Chrome con `--app=`.
 *   3. Apertura normal con el navegador por defecto (`start`/`open`/`xdg-open`).
 *
 * El puerto va **hardcodeado** a 4780 (el default de `dashboardPort`): el script
 * no lee `package.json` ni las opciones del plugin, así que si cambiaste el
 * puerto se avisa y se sugiere abrir la URL real a mano.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Puerto por defecto del dashboard (`dashboardPort` = 4780). */
export const DASHBOARD_PORT = 4780

/** URL que se abre cuando no se pasa otra. */
export const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`

/** Nombre del archivo que puede ejecutar el CLI. */
export const SCRIPT_NAME = "abrir-dashboard.mjs"

/**
 * Aviso de puerto: el script no conoce la opción `dashboardPort`.
 * @param {number} [port]
 * @returns {string}
 */
export function portWarning(port = DASHBOARD_PORT) {
  return `Aviso: este script asume el puerto por defecto ${port}. Si configuraste otro dashboardPort, abre http://127.0.0.1:<tu-puerto> a mano.`
}

/**
 * Rutas candidatas de navegadores Chromium, en orden de preferencia.
 * @param {Record<string, string | undefined>} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {Array<{ label: string, command: string }>}
 */
export function browserCandidates(env = process.env, platform = process.platform) {
  if (platform !== "win32") return []

  const programFiles = env.ProgramFiles ?? "C:\\Program Files"
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
  const localAppData = env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? "", "AppData", "Local")

  return [
    {
      label: "Microsoft Edge",
      command: path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    },
    {
      label: "Microsoft Edge",
      command: path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    },
    {
      label: "Google Chrome",
      command: path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    },
    {
      label: "Google Chrome",
      command: path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    },
    {
      label: "Google Chrome",
      command: path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    },
  ]
}

/**
 * Plan de lanzamiento: primero las ventanas `--app` que existan de verdad y al
 * final la apertura normal, que siempre funciona.
 * @param {{
 *   url?: string,
 *   platform?: NodeJS.Platform,
 *   env?: Record<string, string | undefined>,
 *   exists?: (file: string) => boolean,
 * }} [options]
 * @returns {Array<{ kind: "app" | "default", label: string, command: string, args: string[] }>}
 */
export function buildLaunchPlan(options = {}) {
  const url = options.url ?? DASHBOARD_URL
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync

  /** @type {Array<{ kind: "app" | "default", label: string, command: string, args: string[] }>} */
  const plan = []
  const seen = new Set()

  for (const candidate of browserCandidates(env, platform)) {
    const command = candidate.command
    if (!command || seen.has(command.toLowerCase())) continue
    seen.add(command.toLowerCase())
    if (!exists(command)) continue
    plan.push({ kind: "app", label: candidate.label, command, args: [`--app=${url}`] })
  }

  plan.push(defaultStep(url, platform))
  return plan
}

/**
 * Apertura normal con el navegador por defecto del sistema.
 * @param {string} url
 * @param {NodeJS.Platform} platform
 * @returns {{ kind: "default", label: string, command: string, args: string[] }}
 */
function defaultStep(url, platform) {
  if (platform === "win32") {
    // `start "" <url>` abre el navegador por defecto; el "" es el título.
    return { kind: "default", label: "navegador por defecto", command: "cmd.exe", args: ["/c", "start", "", url] }
  }
  if (platform === "darwin") {
    return { kind: "default", label: "navegador por defecto", command: "open", args: [url] }
  }
  return { kind: "default", label: "navegador por defecto", command: "xdg-open", args: [url] }
}

/**
 * Intenta lanzar un paso y resuelve `true` si el proceso arrancó (sin ENOENT).
 * @param {{ command: string, args: string[] }} step
 * @param {typeof spawn} spawnFn
 * @returns {Promise<boolean>}
 */
function launch(step, spawnFn) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawnFn(step.command, step.args, { detached: true, stdio: "ignore" })
      child.on?.("error", () => done(false))
      child.unref?.()
      // Sin ENOENT sincrónico: en Windows el proceso ya está lanzado.
      setTimeout(() => done(true), 300)
    } catch {
      done(false)
    }
  })
}

/**
 * Abre el dashboard probando el plan en orden. Nunca lanza.
 * @param {{
 *   url?: string,
 *   platform?: NodeJS.Platform,
 *   env?: Record<string, string | undefined>,
 *   exists?: (file: string) => boolean,
 *   spawn?: typeof spawn,
 *   log?: { log: Function, error: Function },
 * }} [options]
 * @returns {Promise<{ kind: string, label: string, command: string, args: string[] } | undefined>}
 */
export async function openDashboard(options = {}) {
  const url = options.url ?? DASHBOARD_URL
  const log = options.log ?? console
  const spawnFn = options.spawn ?? spawn
  const plan = buildLaunchPlan({ ...options, url })

  for (const step of plan) {
    const ok = await launch(step, spawnFn)
    if (!ok) continue
    const mode = step.kind === "app" ? "ventana de app" : "apertura normal"
    log.log(`🖥️  ${step.label} (${mode}): ${url}`)
    return step
  }

  log.error(`❌ No se pudo abrir ningún navegador para ${url}. Abre la URL a mano.`)
  return undefined
}

/**
 * ¿El proceso se lanzó con este script? Igual que en `cierre.mjs`: cuando
 * `scripts/smoke.ts` se bundlea con esbuild, `import.meta.url` apunta al bundle
 * y el guard no debe dispararse.
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

async function main() {
  console.log("Aiapaec · dashboard")
  console.log(portWarning())
  const step = await openDashboard()
  return step ? 0 : 1
}

if (isEntrypoint(fileURLToPath(import.meta.url), process.argv[1])) {
  main().then((code) => {
    process.exitCode = code
  })
}
