import type { LlmAdapter } from "./adapter.js"
import { AnthropicAdapter } from "./anthropic.js"
import { OpenAiAdapter } from "./openai.js"

/** Elige el proveedor por variable de entorno. La clave nunca sale de aquí. */
export function crearAdaptador(env: NodeJS.ProcessEnv): LlmAdapter | null {
  const proveedor = (env.LLM_PROVIDER ?? "anthropic").toLowerCase()
  const timeout = Number(env.LLM_TIMEOUT_MS ?? 60000)
  if (proveedor === "openai") {
    if (!env.OPENAI_API_KEY) return null
    return new OpenAiAdapter(env.OPENAI_API_KEY, env.LLM_MODEL ?? "gpt-4.1-mini", timeout)
  }
  if (!env.ANTHROPIC_API_KEY) return null
  return new AnthropicAdapter(env.ANTHROPIC_API_KEY, env.LLM_MODEL ?? "claude-sonnet-4-5", timeout)
}
