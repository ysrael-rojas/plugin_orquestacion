# Plugin de orquestación para OpenCode

Plugin de orquestación para **OpenCode V2**: implementa la arquitectura "Aiapaec", donde un orquestador delega subtareas en subagentes especializados (contexto, explorador, coder, QA, deployer), con contratos JSON, permisos reales por archivo y ramas derivadas de la rama de desarrollo.

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
  "plugins": ["C:/dev/plugin_orquestacion"]
}
```

También acepta forma con opciones:

```jsonc
{
  "plugins": [
    {
      "package": "C:/dev/plugin_orquestacion",
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

El orquestador llamará a `aiapaec_orchestrate` con un plan de tareas. Las tareas sin dependencias corren en paralelo; las que declaran `dependsOn` esperan.

La herramienta se ejecuta **en segundo plano**: devuelve un `runId` de inmediato y el avance se consulta con `aiapaec_run_status`. Así el trabajo no se pierde si la llamada original se interrumpe.

### Herramientas registradas

| Herramienta | Descripción |
|---|---|
| `aiapaec_orchestrate` | Ejecuta un plan de subtareas en subagentes (segundo plano, devuelve `runId`). |
| `aiapaec_run_status` | Consulta el estado de un run por `runId` (o lista los recientes) con reportes consolidados. |
| `aiapaec_run_abort` | Cancela un run en curso: interrumpe las sesiones hijas y las tareas pendientes quedan `skipped`. |
| `gentle_engram_status` | Diagnóstico de Engram (3 estados). |

### Comando

| Comando | Descripción |
|---|---|
| `/orquestar <petición>` | Inicia una orquestación: el agente descompone la petición y delega con `aiapaec_orchestrate`. |
| `/engram-status` | Muestra el diagnóstico de Engram y cómo resolverlo. |

### Ejecución en segundo plano y recuperación

1. El orquestador llama a `aiapaec_orchestrate` con un `runId` propio (p. ej. `RUN-TASK-101`) y recibe la confirmación de inicio.
2. El run queda registrado en el storage del plugin (`runs/<runId>`) con estado `running` y se actualiza al cerrar cada oleada.
3. El orquestador consulta `aiapaec_run_status` con ese `runId` hasta que el estado sea `completed` (o `failed`).
4. Si la llamada original se interrumpe, **el trabajo continúa**: basta consultar el mismo `runId` (o `aiapaec_run_status` sin argumentos para ver los recientes) para recuperar el resultado.
5. Nunca relanzar un run sin verificar antes su estado.

> v0.8: el modo `wait` se **retiró** porque reintroducía el problema de "Tool result missing" en llamadas largas. Usa siempre el modo segundo plano + `aiapaec_run_status`.

### Worktrees por tarea

Marca una tarea con `worktree: true` y el runner crea un **git worktree** en `<padre>/worktrees/<runId>-<taskId>` desde la rama base: la sesión hija corre con ese directorio como cwd, así que dos coder pueden trabajar **en paralelo** sin conflictos de rama ni de archivos.

- Los dependientes (qa/deployer) reciben automáticamente la ruta del worktree y la rama en su prompt.
- `cleanupWorktrees: true` (opción del plugin o del run) elimina los worktrees de tareas exitosas al terminar; **los de tareas fallidas se conservan** para inspección.
- Ruta por defecto: `<padre del repo>/worktrees` (configurable con `worktreeParent`).
- El coder crea su rama `feat/<task_id>` dentro del worktree, que arranca en HEAD detached sobre la rama base.
- Los worktrees **no heredan `node_modules`** (ignorado por git): el subagente debe ejecutar `npm install` dentro del worktree antes de correr pruebas con dependencias.

## Ejemplo de uso

A continuación se muestra un plan realista y minimalista para `aiapaec_orchestrate`. El objetivo es implementar un endpoint de login con JWT; las tareas de contexto y exploración corren en paralelo, el coder espera a ambas, el QA revisa el código y el deployer prepara el PR.

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
| `tasks[].scope.allowed_files` | Tarea | Opcional. Rutas o globs (`src/auth/**`) permitidos. Advisory por defecto; con `strict_scope: true` es bloqueo real. |
| `tasks[].scope.forbidden_files` | Tarea | Opcional. Lista de rutas o patrones que el subagente no puede editar (bloqueo real). |
| `tasks[].strict_scope` | Tarea | Opcional. Con `allowed_files`, niega `edit` global y solo permite la lista (los globs se respetan tal cual); sin `execute_bash: true` también deniega shell. |
| `tasks[].worktree` | Tarea | Opcional. Ejecuta la tarea en un git worktree aislado (requiere `projectID` de la ubicación). |
| `tasks[].context.summary` | Tarea | Opcional. Resumen de contexto adicional para el subagente. |
| `tasks[].context.engram_ids` | Tarea | Opcional. IDs de observaciones de Engram relevantes para la tarea. |
| `tasks[].permissions.write_files` | Tarea | Opcional. Si es `false`, se aplica una regla `deny` real sobre herramientas de edición. |
| `tasks[].permissions.execute_bash` | Tarea | Opcional. Si es `false`, se aplica una regla `deny` real sobre ejecución de bash. |
| `tasks[].permissions.git_commit` | Tarea | Opcional. Si es `false`, se deniega `git commit` por bash. |
| `tasks[].permissions.push_to_remote` / `create_pull_request` / `production_deploy` | Tarea | Opcional. Acciones sensibles: pasan por un gate de permiso (`permission.assert`) antes de ejecutarse. |
| `tasks[].model` | Tarea | Opcional. Override de modelo en formato `providerID/modelID` (por ejemplo `opencode-go/kimi-k2.7-code`). |
| `runId` | Raíz | Opcional. ID canónico del run (ej. `RUN-TASK-101`). Se usa en sesiones, worktrees y storage. No puede repetirse. |
| `keepSessions` | Raíz | Opcional. Si es `true`, conserva las sesiones hijas tras la orquestación para inspección. |
| `cleanupWorktrees` | Raíz | Opcional. Si es `true`, elimina los worktrees de tareas exitosas al terminar el run. |

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

Si el subagente no devuelve un reporte JSON con `status`, la tarea queda en estado **`unconfirmed`** (⚠️) con el texto como resumen: no se cuenta como éxito y sus dependientes se omiten. Si el reporte declara un `status` distinto de `success`, la tarea se marca como fallida. El reporte se toma del **último** bloque ```json de la respuesta (el contrato de entrada no se confunde con el reporte).

## Permisos

- `permissions.write_files: false` → regla `deny` real sobre `edit`.
- `permissions.execute_bash: false` → regla `deny` real sobre `bash`.
- `scope.forbidden_files` → reglas `deny` reales sobre `edit` (relativas y absolutas).
- `scope.allowed_files` → advisory por defecto; con `strict_scope: true` se convierte en **bloqueo real**: `deny` global de `edit` + `allow` solo para los archivos listados.
- `permissions.push_to_remote`, `create_pull_request`, `production_deploy` → **gate real** con `permission.assert` sobre la sesión orquestadora: si el humano deniega, la tarea falla sin crear sesión. Recomendado en `opencode.json`: `"permissions": [{ "action": "deploy", "resource": "*", "effect": "ask" }]` para que siempre pregunte.

## Git

- Cada tarea de código trabaja en `feat/<task_id>` derivada de `baseBranch` (`dev` por defecto).
- Sin merge ni push a la rama base: el merge lo aprueba el humano.
- Con `worktree: true` cada tarea corre aislada en su propio worktree, lo que permite varios coder en paralelo sin conflictos de rama.

## Opciones del plugin

| Opción | Default | Descripción |
|---|---|---|
| `baseBranch` | `"dev"` | Rama base desde la que se derivan las ramas de tarea. |
| `cleanupSessions` | `false` | Si es `true`, elimina las sesiones hijas al terminar (por defecto se conservan para inspección). |
| `cleanupWorktrees` | `false` | Si es `true`, elimina los worktrees de tareas exitosas al terminar el run (los fallidos se conservan). |
| `worktreeParent` | `<padre del repo>/worktrees` | Directorio padre donde se crean los worktrees. |
| `taskTimeoutMs` | sin límite | Timeout por tarea en milisegundos; al vencer se interrumpe la sesión hija y la tarea falla. |

## Informe de estado

Cada orquestación se guarda en el storage del plugin (`runs/<runId>`) con objetivo, rama base, timestamps, estado (`running`/`completed`/`failed`/`aborted`) y resultados por tarea. El estado se actualiza al cerrar cada oleada, así que sobrevive a interrupciones del tool. Se conservan los **50 runs más recientes** (limpieza automática).

## Limitaciones conocidas (v0.8)

- El estado se consulta con `aiapaec_run_status` (o `/aiapaec` en el TUI); no hay vista en vivo por tarea dentro de la salida.
- `allowed_files` es advisory por defecto; usa `strict_scope: true` en la tarea para bloquearlo. Con `execute_bash: true` el scope no es infalible (shell puede escribir fuera); `strict_scope` deniega bash salvo que lo habilites.
- Los worktrees requieren que la ubicación exponga `projectID` (si no, la tarea con `worktree: true` falla rápido).
- Engram se integra vía MCP (los subagentes usan `mem_*` si están conectados).
- El bloque `config/agents.json` se genera desde `src/agents.ts` con `npm run agents:sync` (no editar a mano).
- Si el servicio se reinicia con un run en curso, el run queda `running` huérfano: `aiapaec_run_status` lo advierte y `aiapaec_run_abort` puede cerrarlo.
- Los worktrees huérfanos tras un crash no se limpian automáticamente (se listan en el resultado y pueden borrarse a mano).

## TUI

Al cargarse, la parte TUI registra el comando **`/aiapaec`** (también en la paleta como "Aiapaec: runs de orquestación"): lista los runs agrupados por `runId`, con objetivo y estado por tarea. Se calcula a partir de las sesiones hijas (`metadata.orquestacion`), sin backend adicional.

## Desarrollo

```bash
npm test             # lint (Biome) + typecheck + pruebas (node:test)
npm run lint         # solo Biome
npm run agents:sync  # regenera config/agents.json desde src/agents.ts
npm run agents:install  # además fusiona los agentes en ~/.config/opencode/opencode.json
```

Si `mem_save` falla con "could not resolve an authoritative OpenCode runtime
session", reinicia el servicio: `opencode service restart` (ver `docs/incidencias.md`).
