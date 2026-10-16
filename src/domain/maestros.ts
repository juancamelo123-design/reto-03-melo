import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import {
  CentroCostoSchema,
  CondicionPagoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  type CentroCosto,
  type Proveedor,
} from "./schemas.js"

export const RUTA_FIXTURES = join("fixtures", "reto-03")

function leerMaestro<T>(directory: string, archivo: string, schema: z.ZodType<T>): T[] {
  const ruta = join(directory, RUTA_FIXTURES, "maestros", archivo)
  return z.array(schema).parse(JSON.parse(readFileSync(ruta, "utf8")))
}

export const cargarProveedores = (d: string): Proveedor[] => leerMaestro(d, "proveedores.json", ProveedorSchema)
export const cargarCentros = (d: string): CentroCosto[] => leerMaestro(d, "centros-costo.json", CentroCostoSchema)
export const cargarIndicadoresIva = (d: string) => leerMaestro(d, "indicadores-iva.json", IndicadorIvaSchema)
export const cargarCondicionesPago = (d: string) => leerMaestro(d, "condiciones-pago.json", CondicionPagoSchema)

/** "900.555.111-2" → "900555111" (se descarta el dígito de verificación). */
export function normalizarNit(nit: string): string {
  const sinDv = nit.split("-")[0] ?? nit
  return sinDv.replace(/\D/g, "")
}

/** "TecnoSuministros S.A.S." → "tecnosuministros". Quita tildes, puntuación y tipo societario. */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(sas|sa|ltda|s a s|s a)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function buscarProveedor(directory: string, nit: string | undefined, nombre: string): Proveedor | null {
  const proveedores = cargarProveedores(directory)
  if (nit) return proveedores.find((p) => normalizarNit(p.nit) === normalizarNit(nit)) ?? null
  return proveedores.find((p) => normalizarNombre(p.nombre) === normalizarNombre(nombre)) ?? null
}
