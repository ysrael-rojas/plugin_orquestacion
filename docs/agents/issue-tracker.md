# Issue tracker: Markdown local

Las specs y los tickets de este repo viven como archivos markdown dentro de
`.scratch/` (ignorado por git). No se usa GitHub Issues: el repo no quiere ruido
de issues.

## Convenciones

- Una feature por directorio: `.scratch/<feature-slug>/`.
- La spec es `.scratch/<feature-slug>/spec.md`.
- Los tickets son **un archivo por ticket**: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,
  numerados desde `01` en orden de dependencia (primero los que no tienen bloqueantes).
  Nunca un archivo combinado.
- El estado de triage va en una línea `Status:` cerca de la cabecera, con uno de
  los cinco roles canónicos (ver `triage-labels.md`): `needs-triage`, `needs-info`,
  `ready-for-agent`, `ready-for-human`, `wontfix`. La categoría va en `Category:`
  (`bug` / `enhancement`).
- Las aristas de bloqueo van en una línea `Blocked by:` con los números/títulos de
  los tickets que la bloquean, o `None (can start immediately)`. Un ticket está
  desbloqueado cuando todos sus bloqueantes están cerrados.
- Los comentarios y el historial se añaden al final del archivo bajo un encabezado
  `## Comments`.

## Cuando una skill dice "publish to the issue tracker"

Crea un archivo nuevo bajo `.scratch/<feature-slug>/` (creando el directorio si
hace falta). `to-spec` escribe `spec.md`; `to-tickets` escribe un archivo por
ticket bajo `issues/`. No mezcles spec y tickets en el mismo archivo.

## Cuando una skill dice "fetch the relevant ticket"

Lee el archivo de la ruta indicada. Normalmente el usuario pasa la ruta o el
número del ticket (`issues/03-...`), no un identificador de tracker.

## Wayfinding (usado por `/wayfinder`, no instalada hoy)

El **mapa** es `.scratch/<effort>/map.md` con el cuerpo Notes / Decisions-so-far /
Fog. Cada **ticket hijo** es `.scratch/<effort>/issues/NN-<slug>.md` con la pregunta
en el cuerpo; una línea `Type:` registra el tipo (`research`/`prototype`/`grilling`/
`task`) y una línea `Status:` registra `claimed`/`resolved`. El bloqueo es una línea
`Blocked by: NN, NN`; un ticket está desbloqueado cuando todos los archivos que
lista están `resolved`. La **frontera** son los archivos abiertos, sin bloqueantes
y sin reclamar, en orden de número. **Reclamar**: `Status: claimed` antes de trabajar.
**Resolver**: respuesta bajo `## Answer`, `Status: resolved` y un puntero de contexto
en `map.md`.
