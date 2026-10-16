import { readFileSync, existsSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, normalize } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { ejecutarTurno, type Sesion } from "./agent/loop.js"
import { crearAdaptador } from "./llm/index.js"

// Carga .env si existe (Node ≥ 20.12). En el hosting las variables vienen del entorno.
if (existsSync(".env")) process.loadEnvFile(".env")

const directory = process.cwd()
const cfg = {
  directory,
  outDir: join(directory, "out"),
  maxIteraciones: Number(process.env.MAX_ITERACIONES ?? 25),
  maxTokensSesion: Number(process.env.MAX_TOKENS_SESION ?? 300000),
}
const llm = crearAdaptador(process.env)
const sesiones = new Map<string, Sesion>()
const MAX_SESIONES = 200

const ChatBody = z.object({ sessionId: z.string().max(100).optional(), message: z.string().min(1).max(4000) })

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  let raw = ""
  for await (const chunk of req) {
    raw += String(chunk)
    if (raw.length > 50_000) throw new Error("Cuerpo demasiado grande")
  }
  return JSON.parse(raw || "{}")
}

function obtenerSesion(id: string | undefined): Sesion {
  const existente = id ? sesiones.get(id) : undefined
  if (existente) return existente
  if (sesiones.size >= MAX_SESIONES) {
    const masVieja = sesiones.keys().next().value
    if (masVieja) sesiones.delete(masVieja)
  }
  const nueva: Sesion = { id: id ?? randomUUID(), historial: [], visible: [], tokens: 0, pendiente: null }
  sesiones.set(nueva.id, nueva)
  return nueva
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, provider: llm?.provider ?? "sin configurar", model: llm?.model ?? null })
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = ChatBody.safeParse(await leerCuerpo(req))
      if (!body.success) return json(res, 400, { error: "Se espera { sessionId?, message }" })
      if (!llm) return json(res, 503, { error: "El servidor no tiene configurada la clave del modelo (ANTHROPIC_API_KEY u OPENAI_API_KEY)." })
      const sesion = obtenerSesion(body.data.sessionId)
      const r = await ejecutarTurno(llm, sesion, body.data.message, cfg)
      return json(res, 200, { sessionId: sesion.id, ...r })
    }

    const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/)
    if (req.method === "GET" && m?.[1]) {
      const s = sesiones.get(m[1])
      return s ? json(res, 200, { id: s.id, tokens: s.tokens, mensajes: s.visible }) : json(res, 404, { error: "Sesión no encontrada" })
    }

    if (req.method === "GET") {
      const ruta = url.pathname === "/" ? "/index.html" : url.pathname
      const archivo = normalize(join(directory, "web", ruta))
      if (archivo.startsWith(join(directory, "web")) && existsSync(archivo)) {
        res.writeHead(200, { "content-type": MIME[extname(archivo)] ?? "application/octet-stream" })
        return res.end(readFileSync(archivo))
      }
    }
    json(res, 404, { error: "No encontrado" })
  } catch (e) {
    // Nunca se devuelve el stack ni variables de entorno.
    json(res, 500, { error: `Error del servidor: ${e instanceof Error ? e.message : "desconocido"}` })
  }
})

const port = Number(process.env.PORT ?? 3000)
server.listen(port, () => {
  console.log(`Agente OC escuchando en http://localhost:${port} · proveedor: ${llm?.provider ?? "SIN CLAVE"} · modelo: ${llm?.model ?? "-"}`)
})
