## Proceso de órdenes de compra en Periferia

- Cada compra llega por correo con tres piezas: solicitud (Excel), cotización del proveedor y correo de aprobación del líder.
- La OC se crea en SAP en la sociedad 1000, organización de compras 1000.
- El correo de aprobación se adjunta como evidencia (texto/PDF con hash sha256).
- Casos disponibles en este entorno: `sol-001` a `sol-006`.

## Matriz de controles

| Regla | Qué verifica | Efecto |
|---|---|---|
| RC1 | Proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo | Bloqueo |
| RC2 | Aprobación existe, dice "Aprobado" y la envía un aprobador del centro de costo | Bloqueo |
| RC3 | Valor total ≤ tope del aprobador en ese centro | Bloqueo |
| RC4 | La subárea pertenece al centro de costo | Bloqueo |
| RC5 | Cotización y solicitud difieren ≤ 2 % (o no hay cotización) | Confirmación |
| RC6 | Indicador de IVA ausente → se toma el default del proveedor | Confirmación + derivado |
| RC7 | Condiciones de pago ausentes → se toman del proveedor | Derivado (informativo) |
| RC8 | Factura con fecha anterior a la solicitud → OC retroactiva | Confirmación + marca en control |
| RC9 | Aprobación con fecha anterior a la solicitud | Confirmación |
| RC10 | cantidad × valor unitario = valor total (± 1) | Bloqueo |

## Códigos de maestros

- Indicadores de IVA: C0 excluido, C1 IVA 19 %, C2 IVA 5 %.
- Condiciones de pago: Z000 inmediato, Z015 15 días, Z030 30 días, Z060 60 días.
- Unidades SAP: UN unidad, H hora, MES mes. La descripción en SAP se limita a 40 caracteres (texto breve).

## Qué hacer con cada resultado

- **Bloqueada**: devolver al solicitante con la razón y la acción sugerida que da `oc_validar`.
- **Pendiente de confirmación**: mostrar ambos valores y pedir confirmación explícita a la analista.
- **Creada**: informar número de OC (serie 45000000xx) y la ruta de la evidencia.
- **Retroactiva**: la dirección mide este desvío del proceso. Se crea solo con confirmación y queda `retroactiva = true` en `out/control.csv`.
- Crear dos veces la misma solicitud devuelve la OC existente (idempotencia).
