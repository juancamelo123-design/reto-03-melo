import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { OrdenCompraSchema, type OrdenCompra, type Paquete, type Validacion } from "./schemas.js"
import type { AprobacionRaw } from "./schemas.js"

const MAX_DESCRIPCION_SAP = 40

export function inferirUnidad(descripcion: string): "UN" | "H" | "MES" {
  const d = descripcion.toLowerCase()
  if (/\bhoras?\b/.test(d)) return "H"
  if (/\b(mes|meses|mensual)\b/.test(d) && !/\bvigencia\b/.test(d)) return "MES"
  return "UN"
}

// ---------- Evidencia (HU-4) ----------

export function textoEvidencia(a: AprobacionRaw): string {
  return [`De: ${a.de}`, `Para: ${a.para ?? ""}`, `Fecha: ${a.fecha}`, `Asunto: ${a.asunto}`, "", a.cuerpo].join("\n")
}

export const sha256 = (texto: string) => createHash("sha256").update(texto, "utf8").digest("hex")

export async function escribirEvidencia(outDir: string, caso: string, a: AprobacionRaw) {
  const carpeta = join(outDir, caso)
  mkdirSync(carpeta, { recursive: true })
  const contenido = textoEvidencia(a)
  const hash = sha256(contenido)
  const rutaTxt = join(carpeta, "aprobacion.txt")
  writeFileSync(rutaTxt, `${contenido}\n\n---\nsha256: ${hash}\n`)

  const pdf = await PDFDocument.create()
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const pagina = pdf.addPage([595, 842])
  let y = 800
  const lineas = ["EVIDENCIA DE APROBACIÓN DE ORDEN DE COMPRA", "", ...contenido.split("\n"), "", `sha256: ${hash}`]
  for (const linea of lineas) {
    // Helvetica estándar usa WinAnsi: soporta tildes y ñ del español.
    pagina.drawText(linea, { x: 50, y, size: 10, font: fuente })
    y -= 16
  }
  const rutaPdf = join(carpeta, "aprobacion.pdf")
  writeFileSync(rutaPdf, await pdf.save())
  return { ruta: rutaTxt, ruta_pdf: rutaPdf, sha256: hash }
}

// ---------- Payload (HU-3) ----------

type Traza = Record<string, string>

export function construirOrden(
  p: Paquete,
  v: Validacion,
  evidenciaSha: string,
): { ok: true; orden: OrdenCompra; trazabilidad: Traza } | { ok: false; error: string } {
  const s = p.solicitud
  if (!v.derivados.proveedor) return { ok: false, error: "No se puede construir la OC: el proveedor no está validado (RC1)." }
  if (!p.aprobacion) return { ok: false, error: "No se puede construir la OC: falta la aprobación (RC2)." }

  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor
  const condiciones = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor
  if (!iva || !condiciones) return { ok: false, error: "Falta indicador de IVA o condiciones de pago y no se pudieron derivar del proveedor." }

  const descripcionTruncada = s.descripcion.length > MAX_DESCRIPCION_SAP
  const excepciones: OrdenCompra["excepciones"] = v.confirmaciones.map((c) => ({ codigo: c.regla, detalle: c.detalle, confirmado_por: null }))
  if (descripcionTruncada)
    excepciones.push({ codigo: "DESC40", detalle: `Descripción truncada a 40 caracteres (texto breve SAP). Original: "${s.descripcion}"`, confirmado_por: "sistema" })

  const orden: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: v.derivados.proveedor,
    moneda: s.moneda,
    condiciones_pago: condiciones,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: evidenciaSha },
    posiciones: [
      {
        numero: 10,
        descripcion: s.descripcion.slice(0, MAX_DESCRIPCION_SAP),
        cantidad: s.cantidad,
        unidad: inferirUnidad(s.descripcion),
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones,
  }

  const valida = OrdenCompraSchema.safeParse(orden)
  if (!valida.success) return { ok: false, error: `El payload no cumple el esquema SAP: ${valida.error.issues.map((i) => i.message).join("; ")}` }

  const trazabilidad: Traza = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": p.cotizacion ? "cotizacion.referencia" : "n/a (sin cotización)",
    sociedad: "constante (PRD 7.4)",
    organizacion_compras: "constante (PRD 7.4)",
    "proveedor.codigo_sap": "maestro.proveedores.codigo_sap",
    "proveedor.nit": "maestro.proveedores.nit",
    "proveedor.nombre": "maestro.proveedores.nombre",
    moneda: "solicitud.moneda",
    condiciones_pago: s.condiciones_pago ? "solicitud.condiciones_pago" : "derivado (maestro.proveedores.condiciones_pago_default)",
    "aprobador.email": "aprobacion.de",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "derivado (sha256 de out/<caso>/aprobacion.txt)",
    "posiciones[0].numero": "constante (primera posición = 10)",
    "posiciones[0].descripcion": descripcionTruncada ? "solicitud.descripcion (truncada a 40)" : "solicitud.descripcion",
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": "derivado (inferido de solicitud.descripcion)",
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": s.indicador_iva ? "solicitud.indicador_iva" : "derivado (maestro.proveedores.indicador_iva_default)",
    excepciones: "derivado (confirmaciones de oc_validar)",
  }
  return { ok: true, orden: valida.data, trazabilidad }
}

export function guardarTrazabilidad(outDir: string, caso: string, traza: Traza): string {
  const carpeta = join(outDir, caso)
  mkdirSync(carpeta, { recursive: true })
  const ruta = join(carpeta, "trazabilidad.json")
  writeFileSync(ruta, JSON.stringify(traza, null, 2))
  return ruta
}

// ---------- Log de control (HU-5) ----------

export type FilaControl = {
  solicitud_id: string
  resultado: "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion" | "error"
  numero_oc: string
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const csv = (v: string) => `"${v.replace(/"/g, '""')}"`

export function registrarControl(outDir: string, f: FilaControl): void {
  mkdirSync(outDir, { recursive: true })
  const ruta = join(outDir, "control.csv")
  if (!existsSync(ruta)) appendFileSync(ruta, "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n")
  const fila = [f.solicitud_id, f.resultado, f.numero_oc, String(f.retroactiva), f.bloqueos.join("|"), f.confirmaciones.join("|"), new Date().toISOString()]
  appendFileSync(ruta, fila.map(csv).join(",") + "\n")
}
