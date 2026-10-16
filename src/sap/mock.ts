import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrdenCompra } from "../domain/schemas.js"
import { cargarProveedores, normalizarNit } from "../domain/maestros.js"
import type { SapAdapter } from "./adapter.js"

const PRIMER_NUMERO = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

/** SAP simulado: escribe una OC por línea en out/sap/ordenes.jsonl. Numeración secuencial desde 4500000001. */
export class SapMock implements SapAdapter {
  private readonly archivo: string

  constructor(private readonly directory: string, outDir: string) {
    const carpeta = join(outDir, "sap")
    mkdirSync(carpeta, { recursive: true })
    this.archivo = join(carpeta, "ordenes.jsonl")
  }

  async consultarProveedor(nit: string) {
    const p = cargarProveedores(this.directory).find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async crearOrden(orden: OrdenCompra) {
    const registros = this.leer()
    const numero_oc = String(PRIMER_NUMERO + registros.length)
    const fecha = new Date().toISOString()
    const registro: Registro = { numero_oc, fecha, orden }
    appendFileSync(this.archivo, JSON.stringify(registro) + "\n")
    return { numero_oc, fecha }
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const r = this.leer().find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  private leer(): Registro[] {
    if (!existsSync(this.archivo)) return []
    return readFileSync(this.archivo, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Registro)
  }
}
