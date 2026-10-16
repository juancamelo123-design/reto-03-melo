import { fetchConTimeout, LlmError, type Bloque, type HerramientaSpec, type LlmAdapter, type Mensaje, type RespuestaLlm } from "./adapter.js"

type MsgOpenAi =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string }

type RespuestaApi = {
  choices: Array<{
    finish_reason: string
    message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
  }>
  usage: { prompt_tokens: number; completion_tokens: number }
}

/** Implementación para Chat Completions de OpenAI. Traduce el formato interno (bloques) al de OpenAI. */
export class OpenAiAdapter implements LlmAdapter {
  /**
   * Sirve para cualquier API compatible con Chat Completions (OpenAI, Google Gemini, Groq…):
   * solo cambian `baseUrl` y la clave.
   */
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs: number,
    private readonly baseUrl = "https://api.openai.com/v1",
    readonly provider = "openai",
  ) {}

  private traducir(system: string, mensajes: Mensaje[]): MsgOpenAi[] {
    const out: MsgOpenAi[] = [{ role: "system", content: system }]
    for (const m of mensajes) {
      const texto = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
      if (m.role === "assistant") {
        const calls = m.content.flatMap((b) =>
          b.type === "tool_use" ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }] : [],
        )
        out.push({ role: "assistant", content: texto || null, ...(calls.length ? { tool_calls: calls } : {}) })
      } else {
        for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content })
        if (texto) out.push({ role: "user", content: texto })
      }
    }
    return out
  }

  async enviar(system: string, mensajes: Mensaje[], herramientas: HerramientaSpec[]): Promise<RespuestaLlm> {
    const res = await fetchConTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: this.traducir(system, mensajes),
          tools: herramientas.map((h) => ({ type: "function", function: { name: h.name, description: h.description, parameters: h.input_schema } })),
        }),
      },
      this.timeoutMs,
    )
    if (!res.ok) throw new LlmError(`El proveedor respondió ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = (await res.json()) as RespuestaApi
    const choice = data.choices[0]
    if (!choice) throw new LlmError("El proveedor devolvió una respuesta vacía.")
    const content: Bloque[] = []
    if (choice.message.content) content.push({ type: "text", text: choice.message.content })
    for (const c of choice.message.tool_calls ?? []) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(c.function.arguments) as Record<string, unknown>
      } catch {
        input = {}
      }
      content.push({ type: "tool_use", id: c.id, name: c.function.name, input })
    }
    return {
      content,
      stop: content.some((b) => b.type === "tool_use") ? "tool_use" : "end",
      usage: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens },
    }
  }
}
