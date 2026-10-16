import { z } from "zod"
import type { HerramientaSpec } from "../llm/adapter.js"
import * as oc from "./oc.js"
import type { ToolContext } from "./oc.js"

type Herramienta = {
  description: string
  args: Record<string, z.ZodType>
  execute: (args: never, ctx: ToolContext) => Promise<string>
}

/** Nombre que ve el modelo: `<archivo>_<export>` (PRD 6.2). */
const modulos: Record<string, Record<string, Herramienta>> = { oc: oc as unknown as Record<string, Herramienta> }

const registro = new Map<string, Herramienta>()
for (const [archivo, exports] of Object.entries(modulos)) {
  for (const [nombre, h] of Object.entries(exports)) {
    if (h && typeof h === "object" && "execute" in h && "args" in h) registro.set(`${archivo}_${nombre}`, h)
  }
}

export function especificaciones(): HerramientaSpec[] {
  return [...registro.entries()].map(([name, h]) => {
    const schema = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
    delete schema.$schema
    return { name, description: h.description, input_schema: schema }
  })
}

/** Valida los argumentos con zod ANTES de ejecutar. Si no cumplen, el error vuelve al modelo. */
export async function ejecutarHerramienta(nombre: string, input: unknown, ctx: ToolContext): Promise<string> {
  const h = registro.get(nombre)
  if (!h) return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
  const parsed = z.object(h.args).safeParse(input)
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre} → ${detalle}` })
  }
  return h.execute(parsed.data as never, ctx)
}
