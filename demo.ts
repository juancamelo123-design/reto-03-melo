/**
 * Verificación sin modelo de lenguaje: llama directamente a las herramientas sobre los 6 casos.
 * Uso: `npm run demo` (o `bun run demo.ts`). No requiere ninguna API key.
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as oc from "./src/tools/oc.js"
import type { ToolContext } from "./src/tools/oc.js"

const directory = process.cwd()
const outDir = join(directory, "out")
rmSync(outDir, { recursive: true, force: true }) // determinismo: out/ se limpia al inicio

const ctx: ToolContext = { directory, sessionId: "demo", outDir, confirmacionHumana: false }
const ctxConfirmado: ToolContext = { ...ctx, confirmacionHumana: true }

type Respuesta = { ok: boolean; data?: Record<string, unknown>; error?: string; [k: string]: unknown }
const parse = (s: string) => JSON.parse(s) as Respuesta
const reglas = (xs: unknown) => (Array.isArray(xs) ? xs.map((x: { regla: string }) => x.regla).join(", ") : "") || "—"

const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]

console.log("═".repeat(78))
console.log(" DEMO · Agente de Órdenes de Compra · herramientas sin modelo")
console.log("═".repeat(78))

for (const caso of casos) {
  const paquete = parse(await oc.leer_paquete.execute({ caso }, ctx))
  if (!paquete.ok) {
    console.log(`\n▶ ${caso}: ERROR al leer → ${paquete.error}`)
    continue
  }
  const v = parse(await oc.validar.execute({ caso }, ctx)).data as Record<string, unknown>
  await oc.construir_payload.execute({ caso }, ctx)
  const crear = parse(await oc.crear.execute({ caso }, ctx))
  const resultado = crear.ok ? `OC ${String(crear.data?.numero_oc)}` : String(crear.error).split(":")[0]
  console.log(`\n▶ ${caso}`)
  console.log(`  apta: ${String(v.apta)} · retroactiva: ${String(v.retroactiva)}`)
  console.log(`  bloqueos: ${reglas(v.bloqueos)}`)
  for (const b of (v.bloqueos as { detalle: string; accion_sugerida: string }[]) ?? []) console.log(`    ✗ ${b.detalle}\n      → ${b.accion_sugerida}`)
  console.log(`  confirmaciones: ${reglas(v.confirmaciones)}`)
  for (const c of (v.confirmaciones as { detalle: string }[]) ?? []) console.log(`    ? ${c.detalle}`)
  for (const i of (v.informativos as string[]) ?? []) console.log(`    ℹ ${i}`)
  console.log(`  resultado: ${resultado}`)
}

console.log("\n" + "─".repeat(78))
console.log(" Idempotencia: sol-001 por segunda vez")
const repetido = parse(await oc.crear.execute({ caso: "sol-001" }, ctx))
console.log(`  numero_oc: ${String(repetido.data?.numero_oc)} · idempotente: ${String(repetido.data?.idempotente)}`)

console.log("\n" + "─".repeat(78))
console.log(" Confirmación del modelo SIN confirmación humana (sol-004, confirmado=true)")
const sinHumano = parse(await oc.crear.execute({ caso: "sol-004", confirmado: true }, ctx))
console.log(`  → ${String(sinHumano.error)}`)

console.log("\n" + "─".repeat(78))
console.log(' Confirmación humana explícita ("confirmo")')
for (const caso of ["sol-004", "sol-005", "sol-006"]) {
  const r = parse(await oc.crear.execute({ caso, confirmado: true }, ctxConfirmado))
  const d = r.data ?? {}
  const ev = d.evidencia as { ruta: string } | undefined
  console.log(`  ${caso}: OC ${String(d.numero_oc)} · retroactiva: ${String(d.retroactiva)} · evidencia: ${ev?.ruta ?? "—"}`)
}

console.log("\n" + "─".repeat(78))
console.log(" out/control.csv")
const control = join(outDir, "control.csv")
if (existsSync(control)) console.log(readFileSync(control, "utf8").replace(/,"20\d\d-[^"]+"$/gm, ',"<ts>"'))
