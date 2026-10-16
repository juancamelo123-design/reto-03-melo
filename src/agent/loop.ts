import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { LlmError, type BloqueToolResult, type LlmAdapter, type Mensaje } from "../llm/adapter.js"
import { ejecutarHerramienta, especificaciones } from "../tools/registry.js"

export type ToolCallVisible = { name: string; args: Record<string, unknown>; ok: boolean; resumen: string }

export type Sesion = {
  id: string
  historial: Mensaje[]
  /** Lo que ve el front: mensajes y llamadas a herramientas en orden. */
  visible: Array<{ role: "user" | "assistant"; text: string; toolCalls?: ToolCallVisible[]; needsConfirmation?: boolean }>
  tokens: number
  /** Caso que quedó esperando confirmación humana en el turno anterior. */
  pendiente: string | null
}

export type ResultadoTurno = { reply: string; toolCalls: ToolCallVisible[]; needsConfirmation: boolean }

export type ConfigAgente = { directory: string; outDir: string; maxIteraciones: number; maxTokensSesion: number }

const AFIRMATIVO = /^\s*(s[ií]|confirmo|confirmado|de acuerdo|ok|okay|dale|procede|adelante|cr[eé]ala|apruebo)\b/i
const NEGATIVO = /\b(no|cancela|rechazo|espera|detente)\b/i

/** CA3: la confirmación la decide el servidor leyendo el mensaje humano, no el modelo. */
export function esConfirmacion(mensaje: string): boolean {
  return AFIRMATIVO.test(mensaje) && !NEGATIVO.test(mensaje.replace(AFIRMATIVO, ""))
}

export function systemPrompt(directory: string): string {
  const prompt = readFileSync(join(directory, "agent", "prompt.md"), "utf8")
  const conocimiento = readFileSync(join(directory, "src", "knowledge", "ordenes-compra.md"), "utf8")
  return `${prompt}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento}`
}

function resumir(resultado: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(resultado) as { ok: boolean; error?: string; data?: Record<string, unknown> }
    if (!r.ok) return { ok: false, resumen: r.error ?? "error" }
    const d = r.data ?? {}
    if ("numero_oc" in d) return { ok: true, resumen: `OC ${String(d.numero_oc)}${d.idempotente ? " (ya existía)" : ""}` }
    if ("apta" in d && Array.isArray(d.bloqueos)) {
      const conf = Array.isArray(d.confirmaciones) ? d.confirmaciones.length : Array.isArray(d.confirmaciones_pendientes) ? d.confirmaciones_pendientes.length : 0
      return { ok: true, resumen: `apta=${String(d.apta)} · ${d.bloqueos.length} bloqueo(s) · ${conf} confirmación(es)` }
    }
    if ("sha256" in d) return { ok: true, resumen: `evidencia ${String(d.ruta)}` }
    if ("solicitud" in d) return { ok: true, resumen: "paquete leído" }
    return { ok: true, resumen: "ok" }
  } catch {
    return { ok: false, resumen: "respuesta no JSON" }
  }
}

function pideConfirmacion(resultado: string): string | null {
  try {
    const r = JSON.parse(resultado) as { ok: boolean; error?: string; data?: { apta?: boolean; confirmaciones?: unknown[]; confirmaciones_pendientes?: unknown[] } }
    if (!r.ok && r.error?.startsWith("REQUIERE_CONFIRMACION")) return "crear"
    const conf = r.data?.confirmaciones ?? r.data?.confirmaciones_pendientes
    if (r.ok && r.data?.apta && Array.isArray(conf) && conf.length > 0) return "validar"
  } catch {
    /* sin confirmación */
  }
  return null
}

export async function ejecutarTurno(llm: LlmAdapter, sesion: Sesion, mensaje: string, cfg: ConfigAgente): Promise<ResultadoTurno> {
  const confirmacionHumana = sesion.pendiente !== null && esConfirmacion(mensaje)
  const respaldo = sesion.historial.length
  const toolCalls: ToolCallVisible[] = []
  const textos: string[] = []
  let casoPendiente: string | null = null
  const creados = new Set<string>()

  sesion.visible.push({ role: "user", text: mensaje })
  sesion.historial.push({ role: "user", content: [{ type: "text", text: mensaje }] })

  try {
    let iteracion = 0
    for (; iteracion < cfg.maxIteraciones; iteracion++) {
      if (sesion.tokens >= cfg.maxTokensSesion) {
        textos.push("Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para continuar.")
        break
      }
      const r = await llm.enviar(systemPrompt(cfg.directory), sesion.historial, especificaciones())
      sesion.tokens += r.usage.input + r.usage.output
      sesion.historial.push({ role: "assistant", content: r.content })
      for (const b of r.content) if (b.type === "text") textos.push(b.text)
      if (r.stop !== "tool_use") break

      const resultados: BloqueToolResult[] = []
      for (const b of r.content) {
        if (b.type !== "tool_use") continue
        // La confirmación humana solo vale para el caso que quedó pendiente, no para cualquier otro.
        const confirmaEsteCaso = confirmacionHumana && b.input.caso === sesion.pendiente
        const ctx = { directory: cfg.directory, outDir: cfg.outDir, sessionId: sesion.id, confirmacionHumana: confirmaEsteCaso }
        const salida = await ejecutarHerramienta(b.name, b.input, ctx)
        const { ok, resumen } = resumir(salida)
        toolCalls.push({ name: b.name, args: b.input, ok, resumen })
        registrarLog(cfg.outDir, { sessionId: sesion.id, tool: b.name, args: b.input, ok, resumen })
        const caso = typeof b.input.caso === "string" ? b.input.caso : null
        if (b.name === "oc_crear" && ok && caso) creados.add(caso)
        if (caso && pideConfirmacion(salida)) casoPendiente = caso
        resultados.push({ type: "tool_result", tool_use_id: b.id, content: salida, is_error: !ok })
      }
      sesion.historial.push({ role: "user", content: resultados })
    }
    if (iteracion >= cfg.maxIteraciones)
      textos.push(`\n\n_Alcancé el tope de ${cfg.maxIteraciones} pasos en este turno. Arriba está lo que alcancé a hacer; pídeme continuar para completar lo que falta._`)
  } catch (e) {
    sesion.historial.length = respaldo // la sesión no muere: se descarta el turno fallido
    const msg = e instanceof LlmError ? e.message : `Error inesperado: ${e instanceof Error ? e.message : String(e)}`
    const reply = `⚠️ ${msg}`
    sesion.visible.push({ role: "assistant", text: reply, toolCalls })
    return { reply, toolCalls, needsConfirmation: false }
  }

  const needsConfirmation = casoPendiente !== null && !creados.has(casoPendiente)
  sesion.pendiente = needsConfirmation ? casoPendiente : null
  const reply = textos.join("\n\n").trim() || "(sin respuesta)"
  sesion.visible.push({ role: "assistant", text: reply, toolCalls, needsConfirmation })
  return { reply, toolCalls, needsConfirmation }
}

function registrarLog(outDir: string, entrada: Record<string, unknown>): void {
  mkdirSync(outDir, { recursive: true })
  appendFileSync(join(outDir, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entrada }) + "\n")
}
