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

## Ejemplo de uso

A continuación se muestra un plan realista y minimalista para `gentle_orchestrate`. El objetivo es implementar un endpoint de login con JWT; las tareas de contexto y exploración corren en paralelo, el coder espera a ambas, el QA revisa el código y el deployer prepara el PR.

```json
{
  "objective": "Implementar el endpoint de login con JWT y preparar el PR hacia dev",
  "tasks": [
    {
      "id": "TASK-101-CTX",
      "agent": "contexto",
      "objective": "Recopilar contexto del dominio de autenticación, modelos de usuario y reglas de negocio actuales.",
      "context": {
        "summary": "Busca memoria previa sobre autenticación y sesiones."
      }
    },
    {
      "id": "TASK-101-EXP",
      "agent": "explorador",
      "objective": "Explorar el repo para identificar dónde agregar el endpoint de login y cómo se manejan errores HTTP."
    },
    {
      "id": "TASK-101-CODER",
      "agent": "coder",
      "objective": "Implementar el endpoint POST /login con validación de credenciales, generación de JWT y manejo de errores en feat/TASK-101-CODER.",
      "dependsOn": ["TASK-101-CTX", "TASK-101-EXP"],
      "scope": {
        "allowed_files": ["src/auth/**", "src/routes/**", "tests/auth/**"]
      },
      "permissions": {
        "write_files": true,
        "execute_bash": true,
        "git_commit": true
      }
    },
    {
      "id": "TASK-101-QA",
      "agent": "qa",
      "objective": "Validar que el endpoint de login tenga tests, manejo de errores y que los commits sigan el formato semántico.",
      "dependsOn": ["TASK-101-CODER"],
      "permissions": {
        "execute_bash": true
      }
    },
    {
      "id": "TASK-101-DEPLOY",
      "agent": "deployer",
      "objective": "Preparar el Pull Request desde feat/TASK-101-CODER hacia dev con descripción y evidencia de tests.",
      "dependsOn": ["TASK-101-QA"],
      "permissions": {
        "write_files": true,
        "git_commit": true
      }
    }
  ],
  "keepSessions": true
}
```

### Descripción de los campos clave

| Campo | Ubicación | Descripción |
|---|---|---|
| `objective` | Raíz | Objetivo global de la orquestación. Se incluye en el prompt de cada subagente como contexto. |
| `tasks` | Raíz | Lista de subtareas. Debe tener al menos un elemento. |
| `tasks[].id` | Tarea | Identificador único de la subtarea (por ejemplo `TASK-101-CODER`). |
| `tasks[].agent` | Tarea | Agente destino registrado en `opencode.json`: `contexto`, `explorador`, `coder`, `qa` o `deployer`. |
| `tasks[].objective` | Tarea | Objetivo concreto que recibe el subagente en su contrato. |
| `tasks[].dependsOn` | Tarea | Opcional. IDs de tareas que deben completarse antes; si alguna falla, esta tarea se omite. |
| `tasks[].branch` | Tarea | Opcional. Rama de trabajo; por defecto se usa `feat/<id>`. |
| `tasks[].scope.allowed_files` | Tarea | Opcional. Lista de rutas o patrones que el subagente debe respetar (advisory en esta fase). |
| `tasks[].scope.forbidden_files` | Tarea | Opcional. Lista de rutas o patrones que el subagente no puede editar (bloqueo real). |
| `tasks[].context.summary` | Tarea | Opcional. Resumen de contexto adicional para el subagente. |
| `tasks[].context.engram_ids` | Tarea | Opcional. IDs de observaciones de Engram relevantes para la tarea. |
| `tasks[].permissions.write_files` | Tarea | Opcional. Si es `false`, se aplica una regla `deny` real sobre herramientas de edición. |
| `tasks[].permissions.execute_bash` | Tarea | Opcional. Si es `false`, se aplica una regla `deny` real sobre ejecución de bash. |
| `tasks[].permissions.git_commit` | Tarea | Opcional. Indica si el subagente puede realizar commits. |
| `tasks[].model` | Tarea | Opcional. Override de modelo en formato `providerID/modelID` (por ejemplo `opencode-go/kimi-k2.7-code`). |
| `keepSessions` | Raíz | Opcional. Si es `true`, conserva las sesiones hijas tras la orquestación para inspección. |

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
