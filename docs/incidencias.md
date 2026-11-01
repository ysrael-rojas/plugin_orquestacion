# Incidencias conocidas

Registro de incidencias pendientes de investigación. Creado como respaldo porque
Engram MCP no está conectado y `mem_save` falla (ver incidencia #2).

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

**Posible causa a investigar:** canal de retorno del tool (`src/tools.ts`,
`src/runner.ts`), p. ej. timeout del tool o tamaño del reporte.

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
