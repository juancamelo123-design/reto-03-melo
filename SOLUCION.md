# SOLUCIÓN · Reto 03 · Agente de Órdenes de Compra SAP

**Candidato:** Juan Camilo Melo Gutiérrez · AI Product Engineer · Periferia IT Group

---

## 1. Problema en una frase

La analista administrativa digita a mano cada orden de compra en SAP y valida de memoria si el aprobador puede aprobar ese monto en ese centro de costo. Eso cuesta tiempo, genera errores que se corrigen en el cierre contable y no deja medir cuántas compras se hacen antes de tener OC.

**A quién le duele:** a la analista (digitación y riesgo de error), a contabilidad y auditoría (control que no es sistemático) y a la dirección (no puede medir el desvío retroactivo).

---

## 2. Arquitectura

```
┌───────────────────────┐   POST /api/chat    ┌──────────────────────────────────────────────┐
│ web/index.html (chat) │ ──────────────────▶ │ src/server.ts  (HTTP nativo de Node)         │
│ · historial           │ ◀────────────────── │   └─ src/agent/loop.ts  ciclo del agente     │
│ · tool calls visibles │  reply, toolCalls,  │        · tope de iteraciones / tokens        │
│ · confirmación ⚠️     │  needsConfirmation  │        · confirmación humana (CA3)           │
└───────────────────────┘                     │        · log out/log.jsonl                   │
                                              │   ├─ src/llm/adapter.ts  ← interfaz propia   │
                                              │   │    ├─ anthropic.ts   ├─ openai.ts        │
                                              │   └─ src/tools/registry.ts (zod → JSON Schema)│
                                              │        └─ src/tools/oc.ts  (5 herramientas)  │
                                              │             └─ src/domain/*  reglas puras    │
                                              │             └─ src/sap/mock.ts (SapAdapter)  │
                                              └──────────────┬──────────────────┬────────────┘
                                                             │                  │
                                              fixtures/ (solo lectura)   out/ (sap/, control.csv,
                                                                          <caso>/evidencia, trazabilidad)
```

| Capa | Dónde vive | Qué cambia ahí |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Cómo conversa el agente y en qué orden usa las herramientas |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | Matriz de controles, códigos de maestros, qué hacer con cada resultado |
| **Ejecución** | `src/tools/oc.ts` y `src/domain/` | Reglas RC1–RC10, payload, evidencia, creación |

Si cambia una regla de negocio, se toca `src/domain/validacion.ts` y la tabla del conocimiento. El servidor no se toca.

**Principio central:** el modelo **orquesta y explica**, pero **no decide valores**. Cada monto, código y número de OC sale de una herramienta determinista. Las herramientas releen la fuente (fixtures y maestros) en cada llamada, así que el modelo no tiene un canal para alterar un valor.

---

## 3. Ciclo del agente

Archivo: `src/agent/loop.ts`.

1. Llega el mensaje del usuario. El **servidor** (no el modelo) decide si ese mensaje es una confirmación explícita (`confirmo`, `sí`, `procede`…, sin negaciones) **y** si hay un caso pendiente de confirmar en esta sesión.
2. Bucle: `modelo → tool_use → validar args con zod → ejecutar → tool_result → modelo`. Hay dos topes:
   - **`MAX_ITERACIONES` por turno (25).** Al alcanzarlo, el agente responde con lo que tiene y lo que falta (CA1).
   - **`MAX_TOKENS_SESION` por sesión.** Evita que un usuario gaste la clave sin límite.
3. Cada llamada queda visible en el chat (nombre, argumentos y resultado resumido) y en `out/log.jsonl` (CA4).
4. **Confirmación humana (CA3), en tres capas:**
   - **Prompt:** ante confirmaciones pendientes, el agente termina el turno con una pregunta cerrada.
   - **Servidor:** `oc_crear` recibe en su contexto `confirmacionHumana = true` **solo** si el último mensaje humano confirmó y el caso es el que estaba pendiente. Si el modelo intenta `confirmado: true` por su cuenta, la herramienta responde `REQUIERE_CONFIRMACION` y registra el intento en `control.csv`. Esto se demuestra en `demo.ts` y lo probé con un modelo simulado.
   - **Front:** cuando `needsConfirmation = true`, el mensaje se resalta y aparecen los botones "Confirmo" / "No crear".
5. **Errores (CA5):** si falla el proveedor (timeout de 60 s, error HTTP), el turno se revierte en el historial y el chat muestra el error en lenguaje claro. La sesión sigue viva. Las herramientas nunca lanzan: devuelven `{ ok: false, error }`.

---

## 4. Elección del modelo

- **Proveedor por defecto:** Anthropic, con `claude-sonnet-5-5` (configurable con `LLM_MODEL`). Vienen incluidas también OpenAI y Google Gemini (a través de un adaptador compatible con Chat Completions con `baseUrl` configurable); cambiar de proveedor es una variable de entorno y no toca el ciclo.
- **Por qué:** la tarea es de orquestación de herramientas y redacción clara en español, no de razonamiento numérico, porque los números los hacen las herramientas. Un modelo de gama media con buen *tool use* es suficiente. Para volumen alto, un modelo pequeño (Haiku o mini) reduce el costo de 3 a 5 veces sin cambiar la arquitectura, porque el control no depende del modelo.
- **Costo estimado por caso.** Supuesto: tarifa de referencia de un modelo de gama media de **USD 3 por millón de tokens de entrada y USD 15 por millón de salida**; hay que verificar la tarifa vigente.
  - Prompt de sistema, conocimiento y esquemas: ≈ 2.500 tokens por llamada.
  - Un caso típico hace 3 o 4 llamadas al modelo con contexto creciente. Medido en la prueba real: ≈ 20.000 tokens por caso, de los cuales ≈ 18.000 son de entrada y ≈ 1.500–2.000 de salida.
  - Costo: ≈ USD 0,054 + 0,023 ≈ **USD 0,08 por caso (≈ COP 300)**. Con modelo pequeño, ≈ USD 0,02.
  - Para comparar: una OC digitada a mano toma minutos de analista y un error de centro de costo se corrige en el cierre.
- **Optimización ya aplicada:** `oc_leer_paquete` no devuelve el texto completo de la cotización al modelo, porque no lo necesita para orquestar.

---

## 5. Matriz de controles

Archivo: `src/domain/validacion.ts`. Es una función pura: el mismo paquete con los mismos maestros da el mismo resultado.

| Regla | Implementación | Tipo | Caso que la activa |
|---|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni dígito de verificación); sin NIT, por nombre normalizado (sin tildes ni tipo societario). Verifica `activo`. Extra: si el NIT de la cotización no coincide con el del proveedor, pide confirmación. | Bloqueo | sol-002 (proveedor inexistente); sol-006 se resuelve por nombre |
| RC2 | La aprobación existe, contiene "Aprobado" no negado ("no aprobado" y "rechazado" no cuentan) y el remitente es aprobador **de ese centro de costo** | Bloqueo | sol-003 (aprobador de CC-3030 aprobando CC-2020) |
| RC3 | `valor_total ≤ tope` del aprobador en ese centro | Bloqueo | En sol-003 la acción sugerida advierte que **ningún** aprobador de CC-2020 tiene tope para $74 M |
| RC4 | Centro de costo existe y la subárea le pertenece | Bloqueo | — |
| RC5 | `abs(cotización − solicitud) / solicitud > 2 %`, o falta la cotización | Confirmación | sol-004 ($26,5 M vs $25 M = 6 %) |
| RC6 | Si falta el IVA, se deriva `indicador_iva_default` y se pide confirmación. Si viene un código que no está en el maestro, se bloquea. | Confirmación + derivado | sol-006 (C1) |
| RC7 | Si faltan las condiciones de pago, se derivan del proveedor (solo se informa). Si vienen con un código inválido, se bloquea. | Derivado | sol-006 (Z030) |
| RC8 | `factura.fecha < fecha_solicitud` → `retroactiva = true` | Confirmación + marca | sol-005 (factura 10-ago, solicitud 27-ago) |
| RC9 | Fecha local de la aprobación < `fecha_solicitud` | Confirmación | — |
| RC10 | `abs(cantidad × valor_unitario − valor_total) > 1` | Bloqueo | — |

**Resultado de `demo.ts`:** sol-001 queda creada sin intervención; sol-002 y sol-003 se bloquean con razón y acción; sol-004, sol-005 y sol-006 piden confirmación y, al confirmarse, se crean; sol-005 queda con `retroactiva = true` en `control.csv`.

**La más difícil: RC2/RC3.** No basta con que el correo diga "Aprobado". Hay que cruzar quién aprueba, para qué centro y hasta qué monto. En sol-003, Felipe Vargas sí es aprobador, pero de Comercial (CC-3030), y la compra se imputa a Administración (CC-2020). Una validación ingenua ("¿es aprobador de algún centro?") la habría dejado pasar. Además, la acción sugerida no es solo "rechazar": el agente detecta que ningún aprobador de CC-2020 tiene tope para $74 M y recomienda escalar o revisar la imputación, que es lo que haría una analista experta.

---

## 6. Diseño del adaptador SAP real

### 6.1 Opción elegida

**Paso 0, antes de escribir código:** confirmar la versión (ECC o S/4HANA) y si existe SAP BTP o un middleware. Eso define la opción.

| Opción | Cuándo | Decisión |
|---|---|---|
| **OData `API_PURCHASEORDER_PROCESS_SRV`** | S/4HANA | **Preferida.** API estándar y soportada, sobre HTTP/JSON, con validaciones de SAP incluidas y `$batch` para atomicidad. |
| **RFC/BAPI `BAPI_PO_CREATE1` + `BAPI_TRANSACTION_COMMIT`** | ECC sin OData | Alternativa sólida. Requiere un conector RFC (SAP Cloud Connector / JCo / node-rfc) en un servicio intermedio. |
| **SAP Integration Suite (BTP)** | Si ya existe en la compañía | Encapsula cualquiera de las dos anteriores, con monitoreo y reintentos gestionados. |
| **Carga por archivo** | Si nada de lo anterior es viable a corto plazo | Es el Plan B (6.5). |

Como la viabilidad no está confirmada, el agente ya depende de la interfaz `SapAdapter` y no de una implementación concreta. Pasar de `SapMock` a `SapODataAdapter` no toca herramientas, prompt ni ciclo.

### 6.2 Mapeo del payload (OData S/4HANA)

| Payload 7.4 | `A_PurchaseOrder` / `A_PurchaseOrderItem` | Nota |
|---|---|---|
| `sociedad` | `CompanyCode` | 1000 |
| `organizacion_compras` | `PurchasingOrganization` | 1000 |
| — | `PurchasingGroup`, `PurchaseOrderType` (NB) | **Faltan en el PRD.** Se agregan como configuración por sociedad. |
| `proveedor.codigo_sap` | `Supplier` | |
| `moneda` | `DocumentCurrency` | |
| `condiciones_pago` | `PaymentTerms` | |
| `referencia.solicitud_id` | Campo de referencia externa de cabecera (p. ej. `CorrespondenceExternalReference`) o campo Z | Clave de idempotencia |
| `posiciones[].numero` | `PurchaseOrderItem` | 10, 20… |
| `posiciones[].descripcion` | `PurchaseOrderItemText` | Máx. 40 caracteres, ya truncado |
| `posiciones[].cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` | Mapear UN→EA o ST, H→H, MES→MON según la configuración |
| `posiciones[].precio_unitario` | `NetPriceAmount` | **Ojo:** los fixtures traen el precio con IVA incluido. SAP espera el neto: `neto = bruto / (1 + tasa)`. |
| `posiciones[].indicador_iva` | `TaxCode` | |
| `centro_costo` | `AccountAssignmentCategory = K` + `CostCenter` en `A_PurOrdAccountAssignment` | Falta `GLAccount`: se deriva por grupo de material o se pide en el maestro |
| `subarea` | Orden interna, elemento PEP o campo Z | Depende de cómo modele SAP la subárea; hay que validarlo con el equipo SAP |
| `aprobador.*` + evidencia | Adjunto vía `API_CV_ATTACHMENT_SRV` (GOS) + texto de cabecera | El PDF con sha256 se adjunta a la OC |

### 6.3 Autenticación y credenciales

- Usuario técnico de comunicación con **rol mínimo**: solo crear y consultar OC en la sociedad 1000.
- OAuth 2.0 *client credentials* vía BTP Destination, o certificado X.509. Las credenciales viven en un **gestor de secretos** (Azure Key Vault, AWS Secrets Manager o el de BTP) y se inyectan al adaptador en tiempo de ejecución.
- **Nunca** en el prompt, el modelo, el front, el repositorio ni los logs. El modelo solo ve el resultado `{ numero_oc }`.

### 6.4 Idempotencia y errores parciales

- **Antes de crear**, `buscarOrdenPorReferencia(solicitud_id)` consulta SAP filtrando por la referencia externa. Si existe, devuelve el número existente (ya implementado en el mock).
- **Timeout o respuesta perdida:** nunca reintentar a ciegas. Primero se consulta por referencia: si la OC quedó creada, se devuelve; si no, se reintenta con *backoff* exponencial (3 intentos).
- **Error parcial:** con OData `$batch`, cabecera y posiciones van en un solo *changeset* atómico (todo o nada). Con BAPI, solo se hace `BAPI_TRANSACTION_COMMIT` si la tabla `RETURN` no trae mensajes tipo E o A; si los trae, `BAPI_TRANSACTION_ROLLBACK`. El agente traduce los mensajes de SAP a lenguaje claro y registra `resultado = error` en `control.csv`.

### 6.5 Plan B si la conexión no es viable

El agente igual ahorra el 80 % del trabajo, que es leer, validar, decidir y armar:

1. **Ficha de OC lista para ME21N:** campos en el orden de la transacción para copiar y pegar, con la evidencia PDF lista para adjuntar.
2. **Archivo de carga masiva** (CSV o Excel con el layout de LSMW o *Migration Cockpit*) que la analista o el equipo SAP sube una vez al día.
3. La analista devuelve el número de OC y el agente lo registra en `control.csv`, así la **medición del desvío retroactivo funciona desde el día 1**, con o sin integración.

---

## 7. Lectura del proceso: OC retroactivas

**Lo que le diría a la dirección.** Una OC retroactiva no es un problema de digitación: es una **compra que se comprometió sin control previo**. Cuando la factura llega antes que la solicitud, la cotización, la aprobación y la OC dejan de ser controles y pasan a ser trámites para poder pagar. El caso sol-005 lo muestra: la factura es del 10 de agosto, la solicitud del 27, y la aprobación dice "ya llegó la factura, por favor crear la OC para poder radicarla". La aprobación existe, pero llegó cuando ya no había nada que decidir.

**Qué haría:**

1. **Medir antes de prohibir.** El agente ya marca `retroactiva = true` en cada OC. En 4 a 6 semanas tendríamos el % real de OC retroactivas por centro de costo, proveedor y aprobador, y sabríamos si es un problema general o se concentra en pocos actores. Hoy nadie lo sabe.
2. **Atacar la causa, no el síntoma.** Típicamente son compras recurrentes (papelería, licencias, servicios) o urgentes. Para las recurrentes propondría **contratos marco u OC abiertas** (pedidos abiertos con un monto anual) que eliminan la OC por factura. Para las urgentes, un **canal exprés** con aprobación en el mismo día.
3. **Política escalonada.** Proponer a la dirección financiera:
   - Tolerar con marca y reporte mensual por centro.
   - Exigir justificación a partir de un umbral.
   - Rechazar facturas sin OC para proveedores fuera de contrato marco.

   Quién decide esa política es una pregunta abierta del PRD. El agente la mide hoy y puede aplicarla mañana: cambiar RC8 de confirmación a bloqueo es una línea de código.
4. **Indicador de éxito:** el % de OC retroactivas baja mes a mes, y el tiempo de solicitud a OC baja lo suficiente para que nadie prefiera comprar primero.

---

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Las herramientas **releen la fuente** y recalculan; ignoran el `paquete` o `payload` que manda el modelo (el payload solo se compara y se rechaza si fue alterado) | Pasar el paquete del modelo entre herramientas, como sugiere el contrato literal | Elimina el riesgo de que el modelo "arregle" un monto (riesgo del PRD 10). Mantengo los argumentos en el contrato por compatibilidad, pero son opcionales. |
| 2 | La **confirmación humana la valida el servidor** (último mensaje humano más caso pendiente), no el modelo | Confiar en que el modelo solo pase `confirmado: true` cuando corresponda | Un control de auditoría no puede depender de que el modelo obedezca el prompt. Probado: el modelo no puede autoconfirmarse. |
| 3 | **Reglas en funciones puras** (`src/domain/`) separadas de las herramientas | Lógica dentro de cada herramienta o validación hecha por el LLM | Determinismo, `demo.ts` sin modelo y reglas testeables. El LLM no valida: explica. |
| 4 | **Adaptador LLM propio con `fetch`** (Anthropic + OpenAI) | SDKs oficiales, LangChain o Vercel AI SDK | Menos dependencias, control total del formato y demostración real de que el ciclo es independiente del proveedor. Costo: más código de traducción en `openai.ts`. |
| 5 | **HTTP nativo de Node y front en un solo HTML** | Express/Next.js y React | Arranque en segundos, cero build y despliegue trivial. Para producción migraría el front a React con streaming. |
| 6 | **Conocimiento en el prompt de sistema** | Herramienta de búsqueda (RAG) sobre el conocimiento | El conocimiento cabe en ~1.000 tokens. RAG tiene sentido cuando crezca (políticas, manual de compras). |

---

## 9. Supuestos

1. `valor_unitario` y `valor_total` de la solicitud **incluyen IVA**, porque coinciden con el "TOTAL (IVA incluido)" de las cotizaciones. El payload usa ese valor; el adaptador real convertiría a neto (6.2).
2. La OC se crea con los **valores de la solicitud aprobada**, no con los de la cotización. Si difieren más del 2 %, se confirma (RC5) y se informa que usar el valor de la cotización exigiría una nueva aprobación.
3. Las fechas de aprobación se comparan por la **fecha local** del correo (Bogotá, -05:00), sin convertir a UTC.
4. En sol-003 el bloqueo se reporta como RC2 (aprobador ajeno al centro). RC3 se evalúa solo cuando el aprobador es válido, pero la acción sugerida advierte que ningún aprobador del centro tiene tope suficiente.
5. La **unidad** se infiere de la descripción ("horas" → H, "mes/mensual" → MES, si no → UN). "Vigencia 12 meses" no convierte una licencia en MES.
6. Si la descripción supera 40 caracteres, se trunca y se registra la excepción `DESC40` con el texto original.
7. Una OC tiene una sola posición, porque los fixtures traen un ítem por solicitud.
8. No se valida la **vigencia de la cotización**. En los casos dados ninguna estaba vencida; sería una regla adicional (ver 10).
9. "Aprobado" negado ("no aprobado", "rechazado") no cuenta como aprobación.

---

## 10. Cobertura

| HU | Estado | Nota / qué falta para producción |
|---|---|---|
| HU-1 Leer paquete | ✅ Hecho | Adjuntos ausentes → `null` + `faltantes`. P1 pendiente: leer `.xlsx` y PDF reales (`exceljs`, `pdf-parse` u OCR). |
| HU-2 Validar | ✅ Hecho | RC1–RC10, más NIT de cotización y "Aprobado" negado. Falta la vigencia de la cotización. |
| HU-3 Payload | ✅ Hecho | Validado con zod; trazabilidad campo por campo en `out/<caso>/trazabilidad.json`. |
| HU-4 Evidencia | ✅ Hecho (P0 + P1) | `aprobacion.txt` y `aprobacion.pdf` con sha256. Producción: el `.eml` original firmado y su adjunto en GOS. |
| HU-5 Crear OC | ✅ Hecho | Numeración desde 4500000001, idempotencia y `control.csv` en cada intento. |
| HU-6 Errores | ✅ Hecho | `{ ok: false, error }` legible con sugerencia. Probado con caso inexistente y argumentos inválidos. |
| Chat y API | ✅ Hecho | Tool calls visibles, confirmación resaltada. Falta *streaming* (opcional). |
| Bonus módulo | ✅ Hecho | `modulo/` se genera desde las mismas fuentes; `npm run modulo:check` evita divergencias. |
| P1 `oc_leer_excel` | ❌ No hecho | Fuera del tiempo; prioricé controles y confirmación. |

**Para producción falta:** autenticación (SSO corporativo), persistencia de sesiones y control en base de datos, adaptador SAP real, ingesta directa del buzón (Graph API / IMAP), tests unitarios por regla y monitoreo de costos por usuario.

---

## 11. Uso de IA

- **Asistente usado:** Claude (Anthropic), como copiloto de desarrollo y documentación.
- **Para qué:**
  - Análisis del PRD y de los fixtures para armar la matriz caso → regla esperada.
  - Andamiaje de la estructura del repositorio.
  - Borradores de las herramientas, del ciclo del agente y de los adaptadores.
  - Prueba del ciclo con un modelo simulado.
  - Redacción de este documento.
- **Qué hice yo:**
  - Definí el enfoque de producto: el modelo orquesta y no decide valores, y la confirmación la valida el servidor.
  - Revisé los resultados de cada caso contra el PRD.
  - Tomé las decisiones de diseño de la sección 8 y la lectura de proceso de la sección 7.
- **Qué descarté de lo propuesto:**
  - **Confiar en el `payload` que envía el modelo** a `oc_crear`. Lo cambié a recalcular y comparar, porque es exactamente el riesgo que señala el PRD.
  - **Dejar que el modelo decida `confirmado: true`.** Lo moví al servidor.
  - **Frameworks de agentes** (LangChain y similares), porque ocultan el ciclo que se pide evaluar.
  - **Validar RC2 solo con "¿es aprobador?"**, porque habría dejado pasar sol-003.

---

## 12. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| El modelo afirma un valor que no vino de herramientas | El prompt lo prohíbe y el diseño lo hace innecesario: los valores salen de herramientas, el payload se recalcula y se compara, y el número de OC solo existe si SAP lo devuelve. Monitorear con muestreo de conversaciones. |
| Confirmación por patrón de texto ambiguo ("sí, pero…") | El patrón excluye negaciones y la confirmación solo aplica al caso pendiente. En producción: botón de confirmación firmado (token por caso) en lugar de texto libre. |
| Fixtures normalizados vs Excel, PDF y correos reales | Extracción con confianza por campo; si la confianza es baja, se confirma con el humano. Piloto en sombra (el agente propone y la analista crea) durante 2 a 4 semanas, midiendo la precisión por campo. |
| Integración SAP no viable o lenta | Interfaz `SapAdapter` + Plan B de archivo de carga. El valor y la medición llegan sin depender de SAP. |
| Costo descontrolado | Topes por turno y sesión, modelo pequeño para volumen y alertas de gasto por usuario. |
| Datos sensibles (NIT, montos) en un proveedor externo | Acuerdo de tratamiento de datos con el proveedor, sin retención de datos, y opción de modelo en Azure o en la nube corporativa. El adaptador propio permite cambiar de proveedor sin rehacer el agente. |
| Cambio en maestros o topes sin reflejarse | En producción, los maestros se consultan en SAP en tiempo real (no archivos), con caché corta. |
| Adopción: la analista no confía en el agente | Trazabilidad visible por campo, evidencia adjunta y piloto con métricas: tiempo por OC, % sin intervención y errores en el cierre. |
