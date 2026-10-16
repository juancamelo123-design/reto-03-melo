import type { Hallazgo, Paquete, Validacion } from "./schemas.js"
import { buscarProveedor, cargarCentros, cargarCondicionesPago, cargarIndicadoresIva, normalizarNit } from "./maestros.js"

const TOLERANCIA_COTIZACION = 0.02
const TOLERANCIA_ARITMETICA = 1

const fmt = (n: number) => `$${n.toLocaleString("es-CO")}`
/** "2026-08-21T10:02:00-05:00" → "2026-08-21" (la fecha local del correo, sin convertir a UTC). */
const fechaLocal = (iso: string) => iso.slice(0, 10)

/** HU-2: aplica RC1–RC10. Función pura sobre el paquete y los maestros: mismo input → mismo output. */
export function validar(directory: string, p: Paquete): Validacion {
  const s = p.solicitud
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const informativos: string[] = []
  const derivados: Validacion["derivados"] = {}

  // RC1 — proveedor existe (por NIT; si no hay NIT, por nombre) y está activo
  const proveedor = buscarProveedor(directory, s.proveedor_nit, s.proveedor_nombre)
  if (!proveedor) {
    bloqueos.push({
      regla: "RC1",
      detalle: `El proveedor "${s.proveedor_nombre}"${s.proveedor_nit ? ` (NIT ${s.proveedor_nit})` : ""} no existe en el maestro de proveedores.`,
      accion_sugerida: "Solicitar a Compras la creación del proveedor en SAP (RUT, cámara de comercio, certificación bancaria) y reprocesar.",
    })
  } else if (!proveedor.activo) {
    bloqueos.push({
      regla: "RC1",
      detalle: `El proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) está inactivo.`,
      accion_sugerida: "Validar con Compras si se reactiva el proveedor o se cotiza con otro activo.",
    })
  } else {
    derivados.proveedor = { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre }
    if (!s.proveedor_nit) informativos.push(`Proveedor identificado por nombre (la solicitud no trae NIT): ${proveedor.nombre}, NIT ${proveedor.nit}.`)
    if (p.cotizacion?.nit && normalizarNit(p.cotizacion.nit) !== normalizarNit(proveedor.nit)) {
      confirmaciones.push({
        regla: "RC1",
        detalle: `El NIT de la cotización (${p.cotizacion.nit}) no coincide con el del proveedor (${proveedor.nit}).`,
        accion_sugerida: "Verificar que la cotización corresponde al proveedor de la solicitud.",
      })
    }
  }

  // RC4 — centro de costo existe y la subárea le pertenece
  const centro = cargarCentros(directory).find((c) => c.centro_costo === s.centro_costo)
  if (!centro) {
    bloqueos.push({
      regla: "RC4",
      detalle: `El centro de costo ${s.centro_costo} no existe en el maestro.`,
      accion_sugerida: "Pedir al solicitante el centro de costo correcto.",
    })
  } else if (!centro.subareas.includes(s.subarea)) {
    bloqueos.push({
      regla: "RC4",
      detalle: `La subárea "${s.subarea}" no pertenece a ${s.centro_costo} (válidas: ${centro.subareas.join(", ")}).`,
      accion_sugerida: "Pedir al solicitante la subárea correcta.",
    })
  }

  // RC2 + RC3 — aprobación válida, de un aprobador del centro y dentro de su tope
  const a = p.aprobacion
  if (!a) {
    bloqueos.push({ regla: "RC2", detalle: "No hay correo de aprobación en el paquete.", accion_sugerida: "Pedir al solicitante el correo de aprobación de su líder." })
  } else if (!a.aprobado) {
    bloqueos.push({ regla: "RC2", detalle: `El correo de ${a.de} no contiene una aprobación explícita ("Aprobado").`, accion_sugerida: "Pedir al líder una respuesta con aprobación explícita." })
  } else if (centro) {
    const aprobador = centro.aprobadores.find((x) => x.email.toLowerCase() === a.de.toLowerCase())
    if (!aprobador) {
      const validos = centro.aprobadores.map((x) => `${x.nombre ?? x.email} (tope ${fmt(x.tope)})`).join(", ")
      const conTope = centro.aprobadores.filter((x) => x.tope >= s.valor_total)
      bloqueos.push({
        regla: "RC2",
        detalle: `${a.de} no es aprobador de ${s.centro_costo}. Aprobadores válidos: ${validos}.`,
        accion_sugerida:
          conTope.length > 0
            ? `Solicitar la aprobación a ${conTope.map((x) => x.email).join(" o ")}.`
            : `Ningún aprobador de ${s.centro_costo} tiene tope para ${fmt(s.valor_total)}: escalar a la dirección financiera o revisar si el gasto corresponde a otro centro de costo.`,
      })
    } else if (s.valor_total > aprobador.tope) {
      bloqueos.push({
        regla: "RC3",
        detalle: `El valor ${fmt(s.valor_total)} supera el tope de ${aprobador.email} (${fmt(aprobador.tope)}) en ${s.centro_costo}.`,
        accion_sugerida: "Solicitar aprobación a un aprobador con tope suficiente.",
      })
    }
    // RC9 — la aprobación no puede ser anterior a la solicitud
    if (fechaLocal(a.fecha) < s.fecha_solicitud) {
      confirmaciones.push({
        regla: "RC9",
        detalle: `La aprobación (${fechaLocal(a.fecha)}) es anterior a la fecha de la solicitud (${s.fecha_solicitud}).`,
        accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
      })
    }
  }

  // RC10 — cantidad × valor unitario = valor total (± 1)
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > TOLERANCIA_ARITMETICA) {
    bloqueos.push({
      regla: "RC10",
      detalle: `${s.cantidad} × ${fmt(s.valor_unitario)} = ${fmt(calculado)}, pero la solicitud dice ${fmt(s.valor_total)}.`,
      accion_sugerida: "Pedir al solicitante corregir cantidades o valores.",
    })
  }

  // RC5 — cotización vs solicitud (≤ 2 %)
  if (!p.cotizacion) {
    confirmaciones.push({ regla: "RC5", detalle: "El paquete no trae cotización.", accion_sugerida: "Confirmar que se crea la OC sin cotización de soporte." })
  } else {
    const diff = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
    if (diff > TOLERANCIA_COTIZACION) {
      confirmaciones.push({
        regla: "RC5",
        detalle: `Cotización ${fmt(p.cotizacion.total)} vs solicitud ${fmt(s.valor_total)}: diferencia de ${(diff * 100).toFixed(1)} % (tolerancia 2 %).`,
        accion_sugerida: "Confirmar con qué valor se crea la OC. El agente usa el valor aprobado de la solicitud; si debe ser el de la cotización, se requiere nueva aprobación.",
      })
    }
  }

  // RC6 — indicador de IVA (derivado del proveedor si falta → confirmación)
  const ivas = cargarIndicadoresIva(directory)
  if (s.indicador_iva) {
    if (!ivas.some((i) => i.codigo === s.indicador_iva))
      bloqueos.push({ regla: "RC6", detalle: `Indicador de IVA "${s.indicador_iva}" no existe en el maestro.`, accion_sugerida: "Corregir el indicador de IVA." })
  } else if (proveedor) {
    const iva = ivas.find((i) => i.codigo === proveedor.indicador_iva_default)
    derivados.indicador_iva = { valor: proveedor.indicador_iva_default, fuente: "maestro.proveedores.indicador_iva_default" }
    confirmaciones.push({
      regla: "RC6",
      detalle: `La solicitud no informa indicador de IVA. Se propone ${proveedor.indicador_iva_default}${iva ? ` (${iva.descripcion})` : ""}, el default del proveedor.`,
      accion_sugerida: "Confirmar el indicador de IVA propuesto.",
    })
  }

  // RC7 — condiciones de pago (derivadas del proveedor si faltan → solo informar)
  const condiciones = cargarCondicionesPago(directory)
  if (s.condiciones_pago) {
    if (!condiciones.some((c) => c.codigo === s.condiciones_pago))
      bloqueos.push({ regla: "RC7", detalle: `Condición de pago "${s.condiciones_pago}" no existe en el maestro.`, accion_sugerida: "Corregir la condición de pago." })
  } else if (proveedor) {
    const c = condiciones.find((x) => x.codigo === proveedor.condiciones_pago_default)
    derivados.condiciones_pago = { valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" }
    informativos.push(`Condiciones de pago derivadas del proveedor: ${proveedor.condiciones_pago_default}${c ? ` (${c.descripcion})` : ""}.`)
  }

  // RC8 — factura anterior a la solicitud → OC retroactiva
  const retroactiva = p.factura !== null && p.factura.fecha < s.fecha_solicitud
  if (retroactiva && p.factura) {
    confirmaciones.push({
      regla: "RC8",
      detalle: `OC retroactiva: la factura ${p.factura.numero} (${p.factura.fecha}) es anterior a la solicitud (${s.fecha_solicitud}). Se compró antes de tener OC.`,
      accion_sugerida: "Confirmar la creación. Quedará marcada retroactiva = true en el log de control para medición de la dirección.",
    })
  }

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, informativos, retroactiva }
}
