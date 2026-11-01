# Incidencias conocidas

Registro de incidencias detectadas en la primera prueba real de orquestación.
**Estado: ambas resueltas en v0.2 (2026-11-01).**

## 1. `aiapaec_orchestrate` (antes `gentle_orchestrate`) pierde el reporte de retorno — 2026-10-31

**Síntoma:** la herramienta `aiapaec_orchestrate` devolvió `Tool execution
interrupted / Tool result missing` dos veces seguidas, aunque las subtareas **sí
se ejecutaron** (verificado con `git`: la rama `feat/TASK-DOCS` y el commit
`0188e9d` existían y eran correctos).

**Impacto:** el orquestador se queda sin el reporte consolidado y no sabe si las
tareas corrieron, lo que invita a re-lanzarlas innecesariamente.

**Mitigación mientras se corrige:**
1. Ante "Tool result missing", verificar el estado real con `git branch` /
   `git log` / `git status` antes de re-lanzar la orquestación.
2. Como fallback, delegar al subagente directo (`subagent` con agente
   `qa`/`coder`/etc.), que sí devuelve reporte.

**Causa raíz:** la herramienta era síncrona y mantenía la llamada abierta durante
minutos; si el paso del agente padre se interrumpía (timeout del proveedor o
interrupción), OpenCode descartaba el resultado. Como el `runId` solo viajaba en
el resultado perdido y no había estado persistente, no había forma de recuperar
el reporte.

**Resuelto (v0.2, commit `b8c4898`):**
- `aiapaec_orchestrate` corre en **segundo plano** y devuelve el `runId` de
  inmediato; el resultado ya no depende del canal del tool.
- Estado persistente por run en `ctx.storage` (`runs/<runId>`), actualizado al
  cerrar cada oleada.
- Nueva herramienta `aiapaec_run_status` para consultar el avance o recuperar el
  reporte consolidado (también lista los runs recientes).
- `runId` opcional elegido por el orquestador → recuperación determinista.
- Prompt del orquestador actualizado: iniciar → sondear → consolidar; nunca
  relanzar sin verificar.

## 2. `mem_save` de Engram falla sin sesión autoritativa — 2026-10-31

**Síntoma:** `mem_save` falla con "could not resolve an authoritative OpenCode
runtime session", tanto desde el orquestador como desde subagentes. Sin embargo,
`mem_current_project` sí resuelve el proyecto (`plugin_orquestacion`).

**Diagnóstico (`gentle_engram_status`):** "Engram está registrado pero no
disponible. Servidor MCP registrado pero no conectado."

**Pasos sugeridos para reparar:**
1. `engram doctor`
2. Re-registrar: `engram setup opencode`
3. Verificar: `opencode mcp list`

**Mitigación mientras se corrige:** registrar decisiones importantes como
archivos en este repo (este documento es el primer ejemplo) y entregar la
respuesta al usuario igualmente — el fallo de memoria nunca bloquea.

**Causa raíz y resolución (2026-11-01, v0.2):**
1. **Bug en la detección del estado MCP** (commit `a4175ec`): el estado real de
   OpenCode V2 es `{ status: "connected" }`; `describeStatus` devolvía el nombre
   de la clave en vez de su valor, así que `gentle_engram_status` reportaba
   "no conectado" aunque el servidor estuviera sano. El smoke test usaba una
   forma inventada del estado; ahora valida contra la forma real
   (`{ data: [{ name, status: { status: "connected" } }] }`).
2. **Proceso `engram serve` huérfano**: había un serve del 13-oct (PID 15560)
   conviviendo con el MCP actual (PID 27724). Engram solo adopta un servidor
   local con identidad coincidente; el huérfano impedía el registro de las
   sesiones nuevas y `mem_save` fallaba cerrado. Se terminó el proceso y se dejó
   un `serve` fresco del binario actual.
3. **`mcp.json` de VS Code inválido** (vacío): corregido a `{}`. Era el único
   error restante de `engram doctor`.
4. Verificación: `engram doctor` → **ok (0 errores)** · `opencode mcp list` →
   `engram connected` · `mem_save` operativo desde sesiones registradas.
