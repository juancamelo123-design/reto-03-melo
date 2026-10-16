/**
 * Herramientas del agente de Órdenes de Compra.
 * Cada export se expone al modelo como `oc_<export>` (contrato PRD 6.2).
 * Son la ÚNICA fuente de valores que el agente puede afirmar. Nunca lanzan: devuelven
 * JSON `{ ok: true, data }` o `{ ok: false, error }`.
 */
import { join } from "node:path"
import { z } from "zod"
import { leerAprobacionCruda, leerPaquete } from "../domain/paquete.js"
import { validar as aplicarReglas } from "../domain/validacion.js"
import {
  construirOrden,
  escribirEvidencia,
  guardarTrazabilidad,
  registrarControl,
  sha256,
  textoEvidencia,
} from "../domain/orden.js"
import type { OrdenCompra } from "../domain/schemas.js"
import { SapMock } from "../sap/mock.js"

export type ToolContext = {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /** Carpeta de salida (por defecto <directory>/out). */
  outDir?: string
  /** true solo si el último mensaje humano confirmó explícitamente (lo decide el servidor, no el modelo). */
  confirmacionHumana?: boolean
}

const ok = (data: unknown) => JSON.stringify({ ok: true, data })
const fallo = (error: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ok: false, error, ...extra })
const outDe = (ctx: ToolContext) => ctx.outDir ?? join(ctx.directory, "out")

const argCaso = z.string().describe('Carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo "sol-001"')

async function seguro(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (e) {
    return fallo(`Error interno de la herramienta: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---------------------------------------------------------------------------

export const leer_paquete = {
  description: "Lee y normaliza el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura si existe).",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    return seguro(async () => {
      const r = leerPaquete(ctx.directory, args.caso)
      if (!r.ok) return fallo(r.error, { sugerencia: "Informar a la analista qué falta y pedirlo al solicitante." })
      const { cotizacion, ...resto } = r.data
      // El texto completo de la cotización no se devuelve al modelo: ahorra tokens y evita que lo "reinterprete".
      return ok({ ...resto, cotizacion: cotizacion ? { ...cotizacion, texto: `${cotizacion.texto.length} caracteres` } : null })
    })
  },
}

export const validar = {
  description: "Valida la solicitud contra maestros y controles RC1–RC10 y devuelve bloqueos, confirmaciones requeridas, valores derivados y si es retroactiva.",
  args: {
    caso: argCaso,
    paquete: z.unknown().optional().describe("Opcional. Se ignora: el servidor relee el paquete desde la fuente para que ningún valor pueda ser alterado."),
  },
  async execute(args: { caso: string; paquete?: unknown }, ctx: ToolContext): Promise<string> {
    return seguro(async () => {
      const r = leerPaquete(ctx.directory, args.caso)
      if (!r.ok) return fallo(r.error)
      return ok(aplicarReglas(ctx.directory, r.data))
    })
  },
}

export const construir_payload = {
  description: "Construye la orden de compra exactamente como quedaría en SAP (sin crearla) y guarda su trazabilidad campo por campo.",
  args: {
    caso: argCaso,
    paquete: z.unknown().optional().describe("Opcional. Se ignora: se relee desde la fuente."),
    derivados: z.unknown().optional().describe("Opcional. Se ignora: se recalculan desde los maestros."),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    return seguro(async () => {
      const r = leerPaquete(ctx.directory, args.caso)
      if (!r.ok) return fallo(r.error)
      const v = aplicarReglas(ctx.directory, r.data)
      const aprobacion = leerAprobacionCruda(ctx.directory, args.caso)
      const sha = aprobacion ? sha256(textoEvidencia(aprobacion)) : "0".repeat(64)
      const c = construirOrden(r.data, v, sha)
      if (!c.ok) return fallo(c.error, { bloqueos: v.bloqueos })
      const ruta = guardarTrazabilidad(outDe(ctx), args.caso, c.trazabilidad)
      return ok({
        orden: c.orden,
        valor_total: r.data.solicitud.valor_total,
        trazabilidad: ruta.replace(ctx.directory + "/", ""),
        apta: v.apta,
        bloqueos: v.bloqueos,
        confirmaciones_pendientes: v.confirmaciones,
      })
    })
  },
}

export const generar_evidencia = {
  description: "Genera la evidencia de aprobación del líder (aprobacion.txt y aprobacion.pdf) con su hash sha256 para adjuntar a la OC.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    return seguro(async () => {
      const aprobacion = leerAprobacionCruda(ctx.directory, args.caso)
      if (!aprobacion) return fallo("El caso no tiene un correo de aprobación legible.", { sugerencia: "Pedir al solicitante el correo de aprobación." })
      const e = await escribirEvidencia(outDe(ctx), args.caso, aprobacion)
      const rel = (p: string) => p.replace(ctx.directory + "/", "")
      return ok({ ruta: rel(e.ruta), ruta_pdf: rel(e.ruta_pdf), sha256: e.sha256 })
    })
  },
}

/** Campos que el modelo NO puede cambiar respecto a lo que calculan las herramientas. */
function huella(o: OrdenCompra) {
  const p = o.posiciones[0]
  return JSON.stringify([o.proveedor.codigo_sap, o.moneda, o.condiciones_pago, o.aprobador.email, p?.cantidad, p?.precio_unitario, p?.centro_costo, p?.subarea, p?.indicador_iva])
}

export const crear = {
  description: "Crea la orden de compra en SAP (simulado) si la solicitud es apta; si hay confirmaciones pendientes exige confirmado=true tras la confirmación explícita del usuario. Es idempotente por solicitud_id.",
  args: {
    caso: argCaso,
    payload: z.unknown().optional().describe("Opcional. La OC que mostraste al usuario; se compara con la recalculada y se rechaza si fue alterada."),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente en su último mensaje las confirmaciones pendientes."),
  },
  async execute(args: { caso: string; payload?: unknown; confirmado?: boolean }, ctx: ToolContext): Promise<string> {
    return seguro(async () => {
      const out = outDe(ctx)
      const r = leerPaquete(ctx.directory, args.caso)
      if (!r.ok) {
        registrarControl(out, { solicitud_id: args.caso, resultado: "error", numero_oc: "", retroactiva: false, bloqueos: [r.error], confirmaciones: [] })
        return fallo(r.error)
      }
      const s = r.data.solicitud
      const sap = new SapMock(ctx.directory, out)
      const v = aplicarReglas(ctx.directory, r.data)
      const reglas = (xs: { regla: string }[]) => xs.map((x) => x.regla)
      const fila = { solicitud_id: s.solicitud_id, retroactiva: v.retroactiva, bloqueos: reglas(v.bloqueos), confirmaciones: reglas(v.confirmaciones) }

      // Idempotencia: la misma solicitud nunca genera una segunda OC.
      const existente = await sap.buscarOrdenPorReferencia(s.solicitud_id)
      if (existente) {
        registrarControl(out, { ...fila, resultado: "idempotente", numero_oc: existente.numero_oc })
        return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true, mensaje: "La OC ya existía; no se creó una segunda." })
      }

      if (!v.apta) {
        registrarControl(out, { ...fila, resultado: "bloqueada", numero_oc: "" })
        return fallo("BLOQUEADA: la solicitud no cumple los controles; no se creó la OC.", { bloqueos: v.bloqueos })
      }

      if (v.confirmaciones.length > 0) {
        const humano = ctx.confirmacionHumana !== false
        if (!args.confirmado || !humano) {
          registrarControl(out, { ...fila, resultado: "pendiente_confirmacion", numero_oc: "" })
          return fallo(
            args.confirmado && !humano
              ? "REQUIERE_CONFIRMACION: el usuario aún no ha confirmado en el chat. Pregúntale explícitamente y termina el turno."
              : "REQUIERE_CONFIRMACION: hay excepciones que el usuario debe confirmar antes de crear la OC.",
            { confirmaciones: v.confirmaciones, retroactiva: v.retroactiva },
          )
        }
      }

      const aprobacion = leerAprobacionCruda(ctx.directory, args.caso)
      if (!aprobacion) return fallo("No hay correo de aprobación para generar la evidencia.")
      const evidencia = await escribirEvidencia(out, args.caso, aprobacion)
      const c = construirOrden(r.data, v, evidencia.sha256)
      if (!c.ok) return fallo(c.error)
      const confirmadoPor = `analista (sesión ${ctx.sessionId})`
      const orden: OrdenCompra = {
        ...c.orden,
        excepciones: c.orden.excepciones.map((e) => (e.confirmado_por === null ? { ...e, confirmado_por: confirmadoPor } : e)),
      }

      if (args.payload !== undefined) {
        const enviado = args.payload as OrdenCompra
        if (enviado?.posiciones && huella(enviado) !== huella(orden))
          return fallo("El payload enviado no coincide con el calculado por las herramientas. No se crea la OC: vuelve a construir el payload con oc_construir_payload.")
      }

      guardarTrazabilidad(out, args.caso, c.trazabilidad)
      const { numero_oc, fecha } = await sap.crearOrden(orden)
      registrarControl(out, { ...fila, resultado: "creada", numero_oc })
      const rel = (p: string) => p.replace(ctx.directory + "/", "")
      return ok({
        numero_oc,
        fecha,
        idempotente: false,
        retroactiva: v.retroactiva,
        evidencia: { ruta: rel(evidencia.ruta), ruta_pdf: rel(evidencia.ruta_pdf), sha256: evidencia.sha256 },
        excepciones_confirmadas: orden.excepciones,
      })
    })
  },
}
