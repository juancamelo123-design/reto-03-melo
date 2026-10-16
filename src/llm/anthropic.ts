import { fetchConTimeout, LlmError, type Bloque, type HerramientaSpec, type LlmAdapter, type Mensaje, type RespuestaLlm } from "./adapter.js"

type RespuestaApi = {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
}

/** Implementación para la Messages API de Anthropic (fetch directo, sin SDK). */
export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs: number,
    private readonly maxTokens = 2048,
  ) {}

  async enviar(system: string, mensajes: Mensaje[], herramientas: HerramientaSpec[]): Promise<RespuestaLlm> {
    const res = await fetchConTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: this.model, max_tokens: this.maxTokens, system, messages: mensajes, tools: herramientas }),
      },
      this.timeoutMs,
    )
    if (!res.ok) throw new LlmError(`El proveedor respondió ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = (await res.json()) as RespuestaApi
    const content: Bloque[] = []
    for (const b of data.content) {
      if (b.type === "text" && b.text) content.push({ type: "text", text: b.text })
      if (b.type === "tool_use" && b.id && b.name) content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} })
    }
    return {
      content,
      stop: data.stop_reason === "tool_use" ? "tool_use" : "end",
      usage: { input: data.usage.input_tokens, output: data.usage.output_tokens },
    }
  }
}
