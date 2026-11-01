import { isAbsolute, join } from "node:path"

import type { PermissionRule, TaskSpec } from "./types"

/**
 * Traduce el contrato de permisos de una tarea a reglas reales de la sesión
 * hija de OpenCode. Las reglas de sesión se evalúan después de las del agente
 * y gana la última que coincida.
 *
 * Nota: `allowed_files` se comunica en el prompt (advisory) en esta fase;
 * `forbidden_files` y `write_files/bash` se aplican como reglas `deny` reales.
 */
export function buildSessionPermissions(task: TaskSpec, workdir: string): PermissionRule[] {
  const rules: PermissionRule[] = []
  const permissions = task.permissions ?? {}

  if (permissions.write_files === false) {
    rules.push({ action: "edit", resource: "*", effect: "deny" })
  }

  if (permissions.execute_bash === false) {
    rules.push({ action: "bash", resource: "*", effect: "deny" })
  }

  const allowed = task.scope?.allowed_files ?? []
  if (task.strict_scope === true && allowed.length > 0) {
    rules.push({ action: "edit", resource: "*", effect: "deny" })
    for (const file of allowed) {
      rules.push({ action: "edit", resource: normalize(file), effect: "allow" })
      if (!isAbsolute(file)) {
        rules.push({ action: "edit", resource: normalize(join(workdir, file)), effect: "allow" })
      }
    }
  }

  // Denegaciones explícitas al final: la última regla coincidente gana.
  for (const file of task.scope?.forbidden_files ?? []) {
    rules.push({ action: "edit", resource: normalize(file), effect: "deny" })
    if (!isAbsolute(file)) {
      rules.push({ action: "edit", resource: normalize(join(workdir, file)), effect: "deny" })
    }
  }

  return rules
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/")
}
