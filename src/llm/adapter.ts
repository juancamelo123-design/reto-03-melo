/**
 * Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos:
 * cambiar de proveedor = escribir otra implementación de `LlmAdapter`, sin tocar el ciclo.
 */
export type BloqueTexto = { type: "text"; text: string }
export type BloqueToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
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
