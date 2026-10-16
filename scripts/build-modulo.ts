/**
 * Genera modulo/ (bonus 9.4) a partir de las MISMAS fuentes que usa la app:
 *   agent/prompt.md                → modulo/agent.md
 *   src/knowledge/ordenes-compra.md → modulo/skill/ordenes-compra/SKILL.md
 *   src/tools/oc.ts                → modulo/tools/oc.ts (re-export, no copia)
 * Con `--check` falla si modulo/ está desactualizado (útil en CI).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const raiz = process.cwd()
const leer = (p: string) => readFileSync(join(raiz, p), "utf8")

const salidas: Record<string, string> = {
  "modulo/agent.md": `---
description: Agente que prepara, valida y crea órdenes de compra en SAP a partir del paquete de solicitud (solicitud, cotización, aprobación).
mode: primary
permission:
  edit: deny
  bash: deny
---

${leer("agent/prompt.md")}`,
  "modulo/skill/ordenes-compra/SKILL.md": `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia — matriz de controles RC1–RC10, códigos de maestros y qué hacer con cada resultado.
---

${leer("src/knowledge/ordenes-compra.md")}`,
  "modulo/tools/oc.ts": `// Re-export de las herramientas de la app: una sola fuente, sin copias divergentes.
// Importable sin el servidor HTTP: import * as oc from "./modulo/tools/oc.js"
export * from "../../src/tools/oc.js"
`,
}

const check = process.argv.includes("--check")
let desactualizado = false
for (const [ruta, contenido] of Object.entries(salidas)) {
  const destino = join(raiz, ruta)
  if (check) {
    if (!existsSync(destino) || readFileSync(destino, "utf8") !== contenido) {
      console.error(`✖ ${ruta} está desactualizado. Corre: npm run modulo:build`)
      desactualizado = true
    }
  } else {
    mkdirSync(dirname(destino), { recursive: true })
    writeFileSync(destino, contenido)
    console.log(`✔ ${ruta}`)
  }
}
if (desactualizado) process.exit(1)
if (check) console.log("✔ modulo/ sincronizado con la app")
