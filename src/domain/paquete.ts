import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AprobacionRawSchema, CorreoSchema, SolicitudSchema, type Paquete } from "./schemas.js"
import { RUTA_FIXTURES } from "./maestros.js"

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

/** "COP 11.400.000" → 11400000 (formato colombiano: punto de miles). */
export function parsearMonto(texto: string): number | null {
  const limpio = texto.replace(/[^\d,.]/g, "").replace(/\./g, "").replace(",", ".")
  const n = Number(limpio)
  return limpio === "" || Number.isNaN(n) ? null : n
}

function campo(texto: string, etiqueta: RegExp): string | null {
  const m = texto.match(etiqueta)
  return m?.[1]?.trim() ?? null
}

function sumarDias(fechaIso: string, dias: number): string {
  const d = new Date(`${fechaIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export function parsearCotizacion(texto: string): NonNullable<Paquete["cotizacion"]> | { error: string } {
  const totalTxt = campo(texto, /^TOTAL[^:]*:\s*(.+)$/im)
  const total = totalTxt ? parsearMonto(totalTxt) : null
  if (total === null) return { error: "La cotización no tiene una línea TOTAL legible." }
  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/im)
  const dias = campo(texto, /^Validez de la oferta:\s*(\d+)\s*d[ií]as/im)
  return {
    referencia: campo(texto, /^COTIZACI[ÓO]N\s+(\S+)/im),
    proveedor: campo(texto, /^Proveedor:\s*(.+)$/im) ?? "",
    nit: campo(texto, /^NIT:\s*(.+)$/im),
    total,
    moneda: /\bUSD\b/.test(totalTxt ?? "") ? "USD" : "COP",
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
  }
}

export function parsearFactura(texto: string): NonNullable<Paquete["factura"]> | { error: string } {
  const numero = campo(texto, /FACTURA[^\n]*No\.\s*(\S+)/i)
  const fecha = campo(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const totalTxt = campo(texto, /^TOTAL:\s*(.+)$/im)
  const total = totalTxt ? parsearMonto(totalTxt) : null
  if (!numero || !fecha || total === null) return { error: "La factura no tiene número, fecha de emisión o total legibles." }
  return { numero, fecha, total }
}

/** "Aprobado" cuenta solo si no está negado ("no aprobado", "rechazado"). */
export function contieneAprobado(cuerpo: string): boolean {
  const t = cuerpo.toLowerCase()
  return /\baprobad[oa]\b/.test(t) && !/\bno\s+(queda\s+)?aprobad[oa]\b/.test(t) && !/\brechazad[oa]\b/.test(t)
}

export function rutaCaso(directory: string, caso: string): string {
  return join(directory, RUTA_FIXTURES, "solicitudes", caso)
}

function leerJson(ruta: string): Resultado<unknown> {
  try {
    return { ok: true, data: JSON.parse(readFileSync(ruta, "utf8")) }
  } catch {
    return { ok: false, error: `JSON malformado en ${ruta.split("/").slice(-2).join("/")}` }
  }
}

function errorZod(archivo: string, issues: { path: PropertyKey[]; message: string }[]): string {
  const detalle = issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
  return `${archivo} no cumple el formato esperado → ${detalle}`
}

/** HU-1: lee y normaliza el paquete. Adjuntos opcionales ausentes → null + `faltantes`. Nunca lanza. */
export function leerPaquete(directory: string, caso: string): Resultado<Paquete> {
  if (!/^[\w-]+$/.test(caso)) return { ok: false, error: `Nombre de caso inválido: "${caso}"` }
  const base = rutaCaso(directory, caso)
  if (!existsSync(base)) return { ok: false, error: `No existe el caso "${caso}". Casos válidos: sol-001 … sol-006.` }

  const faltantes: string[] = []
  const archivo = (n: string) => join(base, n)

  for (const obligatorio of ["correo.json", "solicitud.json"]) {
    if (!existsSync(archivo(obligatorio)))
      return { ok: false, error: `Paquete incompleto: falta ${obligatorio}. Pídelo al solicitante antes de continuar.` }
  }

  const correoJ = leerJson(archivo("correo.json"))
  if (!correoJ.ok) return correoJ
  const correo = CorreoSchema.safeParse(correoJ.data)
  if (!correo.success) return { ok: false, error: errorZod("correo.json", correo.error.issues) }

  const solJ = leerJson(archivo("solicitud.json"))
  if (!solJ.ok) return solJ
  const solicitud = SolicitudSchema.safeParse(solJ.data)
  if (!solicitud.success) return { ok: false, error: errorZod("solicitud.json", solicitud.error.issues) }

  let cotizacion: Paquete["cotizacion"] = null
  if (existsSync(archivo("cotizacion.txt"))) {
    const c = parsearCotizacion(readFileSync(archivo("cotizacion.txt"), "utf8"))
    if ("error" in c) return { ok: false, error: c.error }
    cotizacion = c
  } else faltantes.push("cotizacion")

  let aprobacion: Paquete["aprobacion"] = null
  if (existsSync(archivo("aprobacion.json"))) {
    const aJ = leerJson(archivo("aprobacion.json"))
    if (!aJ.ok) return aJ
    const a = AprobacionRawSchema.safeParse(aJ.data)
    if (!a.success) return { ok: false, error: errorZod("aprobacion.json", a.error.issues) }
    aprobacion = { de: a.data.de, fecha: a.data.fecha, aprobado: contieneAprobado(a.data.cuerpo), texto: a.data.cuerpo }
  } else faltantes.push("aprobacion")

  let factura: Paquete["factura"] = null
  if (existsSync(archivo("factura.txt"))) {
    const f = parsearFactura(readFileSync(archivo("factura.txt"), "utf8"))
    if ("error" in f) return { ok: false, error: f.error }
    factura = f
  }

  const { id, de, asunto, fecha } = correo.data
  return {
    ok: true,
    data: { correo: { id, de, asunto, fecha }, solicitud: solicitud.data, cotizacion, aprobacion, factura, faltantes },
  }
}

export function leerAprobacionCruda(directory: string, caso: string) {
  const ruta = join(rutaCaso(directory, caso), "aprobacion.json")
  if (!existsSync(ruta)) return null
  const r = AprobacionRawSchema.safeParse(JSON.parse(readFileSync(ruta, "utf8")))
  return r.success ? r.data : null
}
