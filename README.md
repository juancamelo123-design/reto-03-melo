# Agente de Órdenes de Compra SAP · Reto 03

Agente conversacional que lee el paquete de una solicitud de compra, lo valida contra los maestros (RC1–RC10), construye la OC, genera la evidencia de aprobación y la crea en un SAP simulado. Las excepciones se devuelven al humano con una recomendación.

- **Link de prueba:** `<URL de Render>` (sin clave de acceso)
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md)

## Levantar en local (un comando)

Requisitos: Node 20+ (o Bun).

```bash
cp .env.example .env        # pon tu ANTHROPIC_API_KEY (u OPENAI_API_KEY con LLM_PROVIDER=openai)
npm install && npm run dev  # http://localhost:3000
```

Con Bun: `bun install && bun run src/server.ts`. El servidor carga `.env` automáticamente si existe.

## Verificación sin modelo (`demo.ts`)

```bash
npm install && npm run demo      # o: bun install && bun run demo.ts
```

Procesa los 6 casos llamando directamente a las herramientas, sin API key. Muestra `apta`, bloqueos, confirmaciones, `retroactiva` y el número de OC o el motivo. También demuestra:

- la idempotencia (`sol-001` dos veces);
- que el modelo no puede autoconfirmarse;
- la confirmación humana explícita de `sol-004`, `sol-005` y `sol-006`.

`out/` se limpia al inicio, así que el resultado es determinista salvo los timestamps.

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `LLM_PROVIDER` | No | `anthropic` (default), `openai` o `gemini` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Sí (una) | Clave del modelo. Solo vive en el backend. |
| `LLM_MODEL` | No | Default `claude-sonnet-4-5` / `gpt-4.1-mini` / `gemini-2.5-flash` |
| `MAX_ITERACIONES` | No | Tope de pasos herramienta → modelo por turno (25) |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (300000) |
| `LLM_TIMEOUT_MS` | No | Timeout al proveedor (60000) |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión |
| `GET` | `/api/health` | `{ ok, provider, model }`, sin claves |

## Estructura

```
agent/prompt.md              comportamiento (system prompt)
src/knowledge/               conocimiento del proceso (matriz de controles, códigos)
src/tools/oc.ts              ejecución: herramientas zod → oc_leer_paquete, oc_validar, oc_construir_payload, oc_generar_evidencia, oc_crear
src/tools/registry.ts        nombra (<archivo>_<export>), valida args con zod y expone JSON Schema al modelo
src/domain/                  reglas puras: lectura, validación RC1–RC10, payload, evidencia, log de control
src/agent/loop.ts            ciclo del agente, tope de iteraciones, confirmación humana, log
src/llm/                     adaptador propio + Anthropic + OpenAI-compatible (OpenAI, Gemini)
src/sap/                     interfaz SapAdapter + mock sobre out/sap/
web/index.html               chat: historial, llamadas a herramientas, confirmación resaltada
modulo/                      bonus: el agente empaquetado (generado desde las mismas fuentes)
demo.ts                      verificación sin modelo
```

## Salidas (`out/`)

- `out/sap/ordenes.jsonl`: OC creadas (desde 4500000001)
- `out/control.csv`: un registro por intento de creación, con la marca `retroactiva`
- `out/log.jsonl`: cada llamada a herramienta desde el chat
- `out/<caso>/aprobacion.txt|pdf`: evidencia con sha256
- `out/<caso>/trazabilidad.json`: fuente de cada campo de la OC

## Bonus: módulo reutilizable

`npm run modulo:build` regenera `modulo/` desde `agent/prompt.md`, `src/knowledge/` y `src/tools/oc.ts`. `npm run modulo:check` falla si `modulo/` quedó desincronizado.
