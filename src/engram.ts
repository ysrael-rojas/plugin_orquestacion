import type { PluginCtx } from "./types"

/**
 * Detección de Engram en tres estados:
 *  - connected: el servidor MCP está registrado y conectado.
 *  - unavailable: registrado pero sin conexión (pending/failed/needs auth/disabled).
 *  - missing: no hay registro MCP de Engram en OpenCode.
 *
 * El binario puede existir sin estar registrado: por eso no basta con
 * comprobar su presencia. Este es el caso real que originó este módulo.
 */

export type EngramState = "connected" | "unavailable" | "missing"

export interface EngramStatus {
  state: EngramState
  serverName?: string
  detail: string
}

interface McpEntry {
  name: string
  status: string
}

export async function detectEngram(ctx: PluginCtx): Promise<EngramStatus> {
  let entries: McpEntry[]
  try {
    entries = normalizeMcpList(await ctx.mcp.list())
  } catch {
    return {
      state: "unavailable",
      detail: "No se pudo consultar el registro MCP de OpenCode.",
    }
  }

  const candidates = entries.filter((entry) => /engram/i.test(entry.name))

  if (candidates.length === 0) {
    return {
      state: "missing",
      detail: "Engram no está registrado como servidor MCP en OpenCode.",
    }
  }

  const connected = candidates.find((entry) => /connected/i.test(entry.status))
  if (connected) {
    return {
      state: "connected",
      serverName: connected.name,
      detail: `Servidor MCP "${connected.name}" conectado.`,
    }
  }

  return {
    state: "unavailable",
    serverName: candidates.map((entry) => entry.name).join(", "),
    detail: `Servidor MCP registrado pero no conectado (estado: ${candidates
      .map((entry) => entry.status)
      .join(", ")}).`,
  }
}

function normalizeMcpList(output: any): McpEntry[] {
  const data = Array.isArray(output) ? output : (output?.data ?? [])
  return data
    .filter((entry: any) => entry && typeof entry.name === "string")
    .map((entry: any) => ({ name: entry.name, status: describeStatus(entry.status) }))
}

function describeStatus(status: any): string {
  if (status == null) return "unknown"
  if (typeof status === "string") return status
  // Forma real de OpenCode V2: { status: "connected" | "pending" | "disabled" | "failed" | "needs_auth" }
  const value = status.status ?? status.type ?? status._tag ?? status.tag
  return typeof value === "string" ? value : "unknown"
}

const INSTALL_GUIDANCE = [
  "Instalación de Engram (Windows):",
  "  1) Con Go instalado (recomendado):",
  "     go install github.com/Gentleman-Programming/engram/v3/cmd/engram@latest",
  "     (el binario queda en %USERPROFILE%\\go\\bin\\engram.exe)",
  "  2) O descarga engram_<version>_windows_amd64.zip desde:",
  "     https://github.com/Gentleman-Programming/engram/releases",
  "  3) Conecta Engram a OpenCode:",
  "     engram setup opencode",
  "  4) Verifica:",
  "     opencode mcp list   (debe mostrar 'engram connected')",
].join("\n")

const CONNECT_GUIDANCE = [
  "El binario y el registro existen, pero el servidor no está conectado.",
  "Pasos:",
  "  1) Revisa el estado: engram doctor",
  "  2) Re-registra la integración: engram setup opencode",
  "  3) Verifica: opencode mcp list",
].join("\n")

export function formatEngramStatus(status: EngramStatus): string {
  const lines: string[] = []

  switch (status.state) {
    case "connected":
      lines.push(`✅ Engram conectado (${status.serverName}).`)
      lines.push(status.detail)
      break
    case "missing":
      lines.push("⚠️ Engram NO está registrado en OpenCode.")
      lines.push("")
      lines.push(INSTALL_GUIDANCE)
      break
    case "unavailable":
      lines.push("⚠️ Engram está registrado pero no disponible.")
      lines.push(status.detail)
      lines.push("")
      lines.push(CONNECT_GUIDANCE)
      break
  }

  return lines.join("\n")
}
