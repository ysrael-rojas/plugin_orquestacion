# Flujo de trabajo — Aiapaec

Cómo se usa el plugin de orquestación en el día a día (v0.8.3).

## Piezas

| Pieza | Qué es |
|---|---|
| **Orquestador** | Agente principal con el que hablas: planifica, delega y valida |
| **Subagentes** | `contexto` (memoria Engram), `explorador` (mapa del repo), `coder` (implementa), `qa` (pruebas), `deployer` (push/PR) |
| **`aiapaec_orchestrate`** | Arranca un run en segundo plano y devuelve el `runId` al instante |
| **`aiapaec_run_status`** | Estado del run: tareas en curso, cerradas, reportes y errores |
| **`aiapaec_run_abort`** | Cancela un run (interrumpe sesiones hijas; pendientes quedan `skipped`) |
| **`/orquestar`** | Atajo: tu petición se convierte en plan de orquestación |
| **`/aiapaec`** | Panel TUI: runs agrupados con objetivo y estado por tarea |
| **`http://127.0.0.1:4780`** | Dashboard web local: run activo con progreso, tabla de tareas, tokens/costo y **feed de actividad en vivo** (últimas 8 acciones por tarea en curso + orquestador; refresco 2.5 s; `dashboardPort` configurable) |
| **`docs/plans/<runId>.md`** | Documento de plan vivo con contexto, tareas y avance |
| **`gentle_engram_status`** | Diagnóstico de Engram (conectado / sin conexión / ausente) |

## Flujo

```
TÚ                          ORQUESTADOR                    SUBAGENTES
 │  1. Describes la            │                              │
 │     petición ─────────────▶ │                              │
 │                             │ 2. contexto (memoria) y      │
 │                             │    explorador (repo)         │
 │                             │    en PARALELO ────────────▶ │
 │                             │ 3. Plan: worktree, scope,    │
 │                             │    permisos, dependsOn       │
 │  4. "iniciado" + runId      │ ◀── aiapaec_orchestrate      │
 │     (segundo plano)         │                              │
 │  5. run_status /aiapaec ──▶ │ ◀── avance en curso ─────────┤
 │                             │ 6. coder → worktree, rama    │
 │                             │    feat/<id> desde dev       │
 │                             │ 7. qa → pruebas + evidencia  │
 │                             │ 8. deployer → GATE de permiso│
 │  9. ⚠️ "¿permito el push?"  │◀──── push de la rama ────────┤
 │ 10. Reporte consolidado     │ ◀── run_status final ────────┤
 │ 11. TÚ decides el merge     │    (el plugin nunca mergea)  │
```

## Ejemplo

Con el agente **orquestador** (o `/orquestar`):

> Implementa el endpoint de login con JWT: busca contexto previo y explora el repo en paralelo; el coder implementa en `feat/TASK-101` con worktree; QA valida con pruebas; el deployer prepara el PR hacia `dev`.

## Qué ocurre por dentro

- **Aislamiento**: cada tarea con `worktree: true` corre en su propio git worktree (carpeta + rama), permitiendo varios coder en paralelo.
- **Scope real**: `strict_scope` bloquea ediciones fuera de `allowed_files`; `forbidden_files`, `write_files`, `bash` y `git commit` son reglas `deny` reales.
- **Validación**: sin reporte JSON con `status`, la tarea queda `unconfirmed` (⚠️) y sus dependientes no corren.
- **Recuperación**: el run vive en el storage (`runs/<runId>`); si la llamada se interrumpe, `run_status` recupera el estado.
- **Documento de plan**: cada run escribe `docs/plans/<runId>.md` con contexto, tabla de tareas y avance; se actualiza por oleada y se marca `aborted` al cancelar.
- **Dashboard en vivo**: `http://127.0.0.1:4780` (solo loopback, opción `dashboardPort`) muestra el run activo con progreso `X/Y`, la tabla de tareas (agente, estado, rama, tiempo, tokens/costo) y el historial plegado; se refresca cada 2.5 s. `aiapaec_orchestrate` y `aiapaec_run_status` incluyen la línea `Dashboard: http://127.0.0.1:<puerto>`. Si falla, la orquestación sigue igual: es best-effort.
- **Feed de actividad**: el plugin escucha los eventos de sesión y guarda en RAM las últimas **8 acciones** de cada sesión registrada (la orquestadora y cada tarea hija), como `tool` + argumento principal truncado a 80 caracteres. Se ve bajo cada tarea ⏳ del dashboard (`hace 5s`), en la sección «Actividad del orquestador» y en la línea `última acción: <tool> → <summary> (hace Xs)` de `aiapaec_run_status`. Nunca guarda salidas completas, no se persiste y no puede romper el run: un evento fallido se ignora. El contrato `/api/state` sube a **v2** (las tareas cerradas no llevan `activity`).
- **Memoria**: las sesiones hijas llevan `parentID` (atribución al orquestador) y Engram guarda decisiones/hallazgos.

## Reglas de operación

1. **Merge**: el plugin nunca mergea a `dev` ni toca `main`; el deployer prepara el PR y pide aprobación.
2. **`mem_save` falla con "authoritative session"**: `opencode service restart` y sesión nueva (ver `docs/incidencias.md`).
3. **Opciones**: `baseBranch` (dev), `taskTimeoutMs`, `runHistory` (50), `cleanupSessions`, `cleanupWorktrees`, `worktreeParent`, `dashboardPort` (4780; `0` desactiva el dashboard).

## Recetario rápido

| Quiero… | Pídele al orquestador… |
|---|---|
| Analizar sin tocar nada | Tareas solo `contexto`/`explorador`, `write_files: false` |
| Implementar con aislamiento | `coder` con `worktree: true`, `strict_scope` y `allowed_files` |
| Dos features en paralelo | Dos tareas `coder` independientes (sin `dependsOn`), ambas con `worktree` |
| Validar antes de publicar | `qa` con `dependsOn` del coder, `write_files: false` |
| Preparar PR | `deployer` con `push_to_remote: true` (gate de permiso) y `human_approval_required` |
| Cancelar algo en curso | `aiapaec_run_abort` con el `runId` |
| Ver historial | `aiapaec_run_status` sin argumentos, o `/aiapaec` en el TUI |
