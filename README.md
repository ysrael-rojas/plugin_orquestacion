# Plugin de orquestación para OpenCode

Plugin de orquestación para **OpenCode V2**: implementa la arquitectura "Gentle Shell", donde un orquestador delega subtareas en subagentes especializados (contexto, explorador, coder, QA, deployer), con contratos JSON, permisos reales por archivo y ramas derivadas de la rama de desarrollo.

Funciona con tu suscripción **OpenCode Go**: los modelos se heredan de tu configuración; no requiere API keys adicionales.

## Requisitos

- OpenCode V2 (probado con v2.2.5)
- Opcional pero recomendado: [Engram](https://github.com/Gentleman-Programming/engram) conectado como MCP (`engram setup opencode`)

## Instalación

### 1. Cargar el plugin

En tu `opencode.json` global (`~/.config/opencode/opencode.json` en Windows también) agrega la ruta del plugin:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/Lenovo/Desktop/proyectos-dev/plugin_orquestacion"]
}
```

También acepta forma con opciones:

```jsonc
{
  "plugins": [
    {
      "package": "C:/Users/Lenovo/Desktop/proyectos-dev/plugin_orquestacion",
      "options": {
        "baseBranch": "dev",
        "cleanupSessions": false
      }
    }
  ]
}
```

### 2. Registrar los agentes

El plugin **no puede crear agentes** (la API V2 solo permite modificarlos). Copia el bloque de [`config/agents.json`](./config/agents.json) dentro del campo `agents` de tu `opencode.json`:

```jsonc
{
  "agents": {
    "orquestador": { "mode": "primary", "model": "opencode-go/glm-5.3", "description": "...", "system": "..." },
    "contexto":    { "mode": "subagent", "model": "opencode-go/glm-5.3-flash", "description": "...", "system": "..." },
    "explorador":  { "mode": "subagent", "model": "opencode-go/glm-5.3-flash", "description": "...", "system": "..." },
    "coder":       { "mode": "subagent", "model": "opencode-go/kimi-k2.7-code", "description": "...", "system": "..." },
    "qa":          { "mode": "subagent", "model": "opencode-go/glm-5.3-flash", "description": "...", "system": "..." },
    "deployer":    { "mode": "subagent", "model": "opencode-go/glm-5.3-flash", "description": "...", "system": "..." }
  }
}
```

Puedes cambiar modelos o prompts libremente; los IDs son los que usa el orquestador.

### 3. Verificar

- Abre una sesión nueva con el agente **orquestador** (o usa el agente principal y pídele orquestar).
- Ejecuta `/engram-status` para ver el estado de la memoria.

## Uso

Pídele al orquestador algo como:

> Orquesta: implementa el endpoint de login con JWT. Primero pide contexto y explora el repo; luego que el coder implemente en `feat/TASK-101`, QA valida y el deployer prepara el PR hacia `dev`.

El orquestador llamará a `gentle_orchestrate` con un plan de tareas. Las tareas sin dependencias corren en paralelo; las que declaran `dependsOn` esperan.

### Herramientas registradas

| Herramienta | Descripción |
|---|---|
| `gentle_orchestrate` | Ejecuta un plan de subtareas en subagentes. Devuelve reporte consolidado. |
| `gentle_engram_status` | Diagnóstico de Engram (3 estados). |

### Comando

| Comando | Descripción |
|---|---|
| `/engram-status` | Muestra el diagnóstico de Engram y cómo resolverlo. |

## Contratos

Cada subtarea recibe un contrato JSON (contrato A) con `task_id`, `target_agent`, `objective`, `branch`, `base_branch`, `scope`, `context_references` y `permissions`.

El subagente debe cerrar con un reporte JSON (contrato B):

```json
{
  "task_id": "TASK-101",
  "status": "success",
  "summary": "...",
  "artifacts": { "modified_files": [], "git_branch": "feat/TASK-101", "last_commit_hash": "" },
  "next_recommended_action": "..."
}
```

Si el subagente no devuelve JSON válido, el runner conserva el texto como resumen y marca la tarea como completada con reporte vacío (sin bloquear la orquestación). Si el reporte declara un `status` distinto de `success`, la tarea se marca como fallida y sus dependientes se omiten.

## Permisos

- `permissions.write_files: false` → regla `deny` real sobre `edit`.
- `permissions.execute_bash: false` → regla `deny` real sobre `bash`.
- `scope.forbidden_files` → reglas `deny` reales sobre `edit` (relativas y absolutas).
- `scope.allowed_files` → se comunica en el prompt (advisory) en esta fase.

## Git

- Cada tarea de código trabaja en `feat/<task_id>` derivada de `baseBranch` (`dev` por defecto).
- Sin merge ni push a la rama base: el merge lo aprueba el humano.
- En Fase 2, el aislamiento por tarea usará **worktrees** (`ctx.worktree`), lo que permitirá varios coder en paralelo sin conflictos de rama.

## Opciones del plugin

| Opción | Default | Descripción |
|---|---|---|
| `baseBranch` | `"dev"` | Rama base desde la que se derivan las ramas de tarea. |
| `cleanupSessions` | `false` | Si es `true`, elimina las sesiones hijas al terminar (por defecto se conservan para inspección). |

## Informe de estado

Cada orquestación se guarda en el storage del plugin (`runs/<runId>`) con objetivo, rama base, timestamps y resultados por tarea.

## Limitaciones conocidas (v0.1)

- Sin TUI: el estado se ve en las sesiones hijas y en el reporte de la herramienta.
- `allowed_files` todavía no es un bloqueo estricto (solo `forbidden_files` y `write_files`/`bash`).
- Engram se integra vía MCP (los subagentes usan `mem_*` si están conectados).
- El bloque `config/agents.json` es una copia de `src/agents.ts`; mantener ambos en sincronía si se editan prompts.
