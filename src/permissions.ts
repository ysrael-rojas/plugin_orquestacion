import { isAbsolute, join } from "node:path"

import type { PermissionRule, TaskSpec } from "./types"

/**
 * Traduce el contrato de permisos de una tarea a reglas reales de la sesión
 * hija de OpenCode. Las reglas de sesión se evalúan después de las del agente
 * y gana la última que coincida.
 *
 * Nota: con `execute_bash: true` el scope de archivos no se puede garantizar
 * por completo (bash puede escribir donde quiera); `strict_scope` deniega bash
 * salvo que se habilite explícitamente.
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

  if (permissions.git_commit === false) {
    rules.push({ action: "bash", resource: "git commit*", effect: "deny" })
    rules.push({ action: "bash", resource: "git -c * commit*", effect: "deny" })
  }

  const allowed = task.scope?.allowed_files ?? []
  if (task.strict_scope === true && allowed.length > 0) {
    rules.push({ action: "edit", resource: "*", effect: "deny" })
    for (const file of allowed) {
      rules.push({ action: "edit", resource: normalize(file), effect: "allow" })
      if (!isAbsolute(file) && !hasGlob(file)) {
        rules.push({ action: "edit", resource: normalize(join(workdir, file)), effect: "allow" })
      }
    }

    if (permissions.execute_bash !== true) {
      // Sin bash no hay forma de saltarse el scope de archivos.
      rules.push({ action: "bash", resource: "*", effect: "deny" })
    }
  }

  // Denegaciones explícitas al final: la última regla coincidente gana.
  for (const file of task.scope?.forbidden_files ?? []) {
    rules.push({ action: "edit", resource: normalize(file), effect: "deny" })
    if (!isAbsolute(file) && !hasGlob(file)) {
      rules.push({ action: "edit", resource: normalize(join(workdir, file)), effect: "deny" })
    }
  }

  return rules
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/")
}

function hasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value)
}
