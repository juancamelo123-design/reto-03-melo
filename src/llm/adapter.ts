/**
 * Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos:
 * cambiar de proveedor = escribir otra implementación de `LlmAdapter`, sin tocar el ciclo.
 */
export type BloqueTexto = { type: "text"; text: string }
export type BloqueToolUse = {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  /** Datos opacos del proveedor que deben devolverse tal cual (p. ej. thought_signature de Gemini). */
  extra?: Record<string, unknown>
}
export type BloqueToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export type Bloque = BloqueTexto | BloqueToolUse | BloqueToolResult

export type Mensaje = { role: "user" | "assistant"; content: Bloque[] }

export type HerramientaSpec = { name: string; description: string; input_schema: Record<string, unknown> }

export type RespuestaLlm = {
  content: Bloque[]
  stop: "tool_use" | "end"
  usage: { input: number; output: number }
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(system: string, mensajes: Mensaje[], herramientas: HerramientaSpec[]): Promise<RespuestaLlm>
}

export class LlmError extends Error {}

/** fetch con timeout: un proveedor lento no cuelga la sesión. */
export async function fetchConTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const control = new AbortController()
  const t = setTimeout(() => control.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: control.signal })
  } catch (e) {
    if (control.signal.aborted) throw new LlmError(`El proveedor del modelo no respondió en ${ms / 1000} s. Intenta de nuevo.`)
    throw new LlmError(`No se pudo contactar al proveedor del modelo: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    clearTimeout(t)
  }
}

const REINTENTABLES = new Set([429, 500, 502, 503, 529])

/**
 * Reintenta ante saturación o límite de cuota del proveedor (429/5xx) con espera creciente.
 * Respeta `retry-after` si viene; nunca espera más de 20 s por intento.
 */
export async function fetchConReintentos(url: string, init: RequestInit, timeoutMs: number, intentos = 3): Promise<Response> {
  let res = await fetchConTimeout(url, init, timeoutMs)
  for (let i = 1; i <= intentos && REINTENTABLES.has(res.status); i++) {
    const sugerido = Number(res.headers.get("retry-after"))
    const espera = Math.min(Number.isFinite(sugerido) && sugerido > 0 ? sugerido * 1000 : 2000 * 2 ** (i - 1), 20000)
    await new Promise((r) => setTimeout(r, espera))
    res = await fetchConTimeout(url, init, timeoutMs)
  }
  if (REINTENTABLES.has(res.status))
    throw new LlmError(
      res.status === 429
        ? "El proveedor del modelo alcanzó su límite de uso por minuto. Espera unos segundos e intenta de nuevo."
        : "El proveedor del modelo está saturado en este momento. Intenta de nuevo en unos segundos.",
    )
  return res
}
