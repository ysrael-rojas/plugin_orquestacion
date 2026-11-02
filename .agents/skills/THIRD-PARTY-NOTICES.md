# Avisos de terceros - catálogo de skills

Las skills de este directorio son contenido de terceros copiado tal cual
(vendorizado). No se editan a mano: cualquier cambio upstream se re-copia.

## Origen

| Campo | Valor |
| --- | --- |
| Repositorio | https://github.com/mattpocock/skills |
| Autor | Matt Pocock |
| Licencia | MIT (texto completo abajo) |
| Commit vendorizado | 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d |
| Commit (corto) | 4ae2317 |
| Fecha del commit | 2026-10-31 |
| Clonado con | git clone --depth 1 (superficial) |

## Skills incluidas

| Directorio local | Ruta upstream | Invocación |
| --- | --- | --- |
| tdd | skills/engineering/tdd | automática |
| code-review | skills/engineering/code-review | automática |
| diagnosing-bugs | skills/engineering/diagnosing-bugs | automática |
| research | skills/engineering/research | automática |
| domain-modeling | skills/engineering/domain-modeling | automática |
| codebase-design | skills/engineering/codebase-design | automática |
| grill-with-docs | skills/engineering/grill-with-docs | solo explícita |
| grilling | skills/productivity/grilling | automática |
| grill-me | skills/productivity/grill-me | solo explícita |

Cada directorio se copia **completo y aplanado** (sin el prefijo
skills/engineering/ ni skills/productivity/): SKILL.md, los documentos de
soporte que el cuerpo del SKILL.md referencia (mocking.md, tests.md,
ADR-FORMAT.md, GLOSSARY-FORMAT.md, DEEPENING.md, DESIGN-IT-TWICE.md),
scripts/hitl-loop.template.sh y agents/openai.yaml.

## Cómo los interpreta el plugin

src/skills.ts recorre .agents/skills/*/SKILL.md (solo directorios) y lee
estas claves del frontmatter YAML:

- name: nombre visible de la skill (si falta, se usa el nombre del directorio).
- description: descripción usada para la invocación automática.
- disable-model-invocation: true se traduce a autoinvoke: false (la skill solo
  se puede invocar de forma explícita).

El resto de claves del frontmatter y los archivos auxiliares **no** se
interpretan: se conservan para no divergir del upstream y para que la copia
siga siendo utilizable por otras herramientas. En particular:

- agents/openai.yaml es metadata para el ecosistema OpenAI/Codex
  (interface.display_name, interface.short_description y, cuando aplica,
  policy.allow_implicit_invocation). El plugin no lo lee; la decisión de
  autoinvocación sale del SKILL.md.
- grill-with-docs declara la restricción por partida doble:
  disable-model-invocation: true en SKILL.md y
  policy.allow_implicit_invocation: false en agents/openai.yaml.
- Los documentos de soporte se referencian desde el cuerpo del SKILL.md con
  rutas relativas, por eso viajan en el mismo directorio.

skills-lock.json (raíz del repo) guarda los hashes de las versiones
instaladas originalmente; grilling y grill-me ya coincidían byte a byte con
este commit, así que su hash no cambia.

## Licencia MIT

```text
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the Software), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
