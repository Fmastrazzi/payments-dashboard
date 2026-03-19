# Product Tech Lead — Knowledge Base
## Payments Portal & Portal de Operaciones (ComunidadFeliz)

---

## 1. ARQUITECTURA GENERAL

### Sistema de pagos (visión macro)
ComunidadFeliz opera un ecosistema de 4 aplicaciones relacionadas con pagos:

1. **Web** (monolito Rails) — app principal donde residen los residentes y admins de comunidades.
2. **Payments Portal 2.0** (Rails 6.1.4 / Ruby 3.0.3 / PostgreSQL) — microservicio dedicado a pagos. Repo: `ComunidadFeliz/Payments-Portal`.
3. **Portal de Operaciones** — herramienta interna para el equipo de finanzas/operaciones. Incluye reconciliación bancaria vía Fintoc.
4. **Portal de Devoluciones** — herramienta de conciliación y gestión de dispersiones diarias.

### Filosofía de diseño
El objetivo del Payments Portal 2.0 fue **desacoplar la lógica de pagos de Web**. Antes, cada nueva pasarela o tipo de pago requería duplicar controladores en Web. Con el nuevo portal, Web solo envía una categoría + metadata → Portal de Pagos ejecuta el cobro → responde con resultado. Esto redujo ~50% el tiempo de integración de nuevas pasarelas.

---

## 2. PAYMENTS PORTAL 2.0

### Tech Stack
- Ruby 3.0.3 / Rails 6.1.4 / PostgreSQL
- Repo: `ComunidadFeliz/Payments-Portal` (también referenciado como `PaymentsPortal`)
- Sidekiq + Redis para background jobs
- JWT para autenticación de API

### Entidades principales
- **Company**: Representa una empresa (ej. ComunidadFeliz o una comunidad independiente). Tiene API Key.
- **Office**: Representa una comunidad específica dentro de una Company.
- **PaymentGateway**: Registro de una pasarela (Webpay Plus, OneClick, Kushki, Toku, Etpay).
- **PaymentGatewayOfficeSetting**: Configuración de una pasarela para una oficina específica (claves API, ambiente, etc.).
- **Payment**: Modelo central de pagos. Tiene 3 campos JSONB:
  - `data`: lo que se envía a la pasarela para iniciar la transacción.
  - `metadata`: respuesta completa de la pasarela.
  - `errors_info`: errores de servidor, comunicación o pasarela (ej. tarjeta inválida).
- **PurchaseOrder**: Orden de compra. IDs con letra "b" = viejo portal. Sin letra = nuevo portal.

### Patrón Processor
Cada pasarela tiene su propio processor en `app/lib/processors/<gateway>/`. Se modela sobre `app/lib/processors/base/`. Ejemplo de referencia: `webpay_one_click`.

Archivos por processor:
- `constants.rb` — claves privadas/públicas
- `enrollment.rb` — guardar tarjeta (tokenización)
- `remove_enrollment.rb` — eliminar tarjeta
- `finish_enrollment.rb` — verificar registro exitoso
- `transaction.rb` — ejecutar cobro con tarjeta inscrita
- `finish_transaction.rb` — registrar resultado post-cobro
- `transaction_status.rb` — forzar actualización de estado
- `refund_transaction.rb` — devolución

### Modos de pasarela
Definidos en `app/lib/constants/payment_gateway_types.rb`:
- `checkout`: usa vistas tercerizadas (ej. formulario Webpay)
- `service`: consumo directo de API (ej. OneClick para cobros automáticos)

### Webhooks
Registrados en `PaymentGatewayCallbacksController`. Usan `Processors::Base::FinishTransaction.new(payment: payment).call` para actualizar estado del pago asincrónicamente.

### Calculator
`app/lib/calculator/<gateway>.rb` — calcula comisiones por pasarela. Hereda de `base`.

### Token Encryptor
Todos los tokens se encriptan. Recomendación pendiente: refactorizar a `base.rb` compartido o usar AWS KMS.

---

## 3. PASARELAS DE PAGO

### Webpay Plus (Transbank - Chile)
- Pago único con tarjeta crédito/débito.
- Flujo checkout: Web → Portal inicia transacción → redirige usuario a formulario Transbank → Transbank redirige de vuelta → Portal confirma.
- Tiempo máximo en formulario: 4 min (producción), 10 min (integración).
- Código comercio en producción CF: `597034165149`, `597043336634`, `597044441581`.
- Códigos de respuesta de rechazo: nivel 1 (general) y nivel 2 (detallado). Código `-11` = bloqueo por reintentos excesivos (MASTERCARD: 8 reintentos/24h; VISA: 16 reintentos/30 días).

### Webpay OneClick (Transbank - Chile)
- Pago recurrente/automático con tarjeta inscrita (tokenizada).
- Inscripción: usuario ingresa tarjeta una vez → Transbank devuelve token → Portal guarda token encriptado.
- Pago automático: Portal usa el token sin intervención del usuario.
- Código comercio en producción CF: `597043336652`, `597044441590`, `597045336802`.

### Kushki (Colombia y otros países)
- Integración multi-país (CO, MX, etc.).
- Setup vía rake task: `lib/tasks/kushki_initial_setup.rake` (crea PaymentGateway, Currency, asocia moneda).
- Schema de validación: `app/lib/payment_gateway/schemas/kushki_co.json`.
- PR de referencia: `ComunidadFeliz/PaymentsPortal/pull/244`.

### Toku (Chile)
- Reemplaza a Etpay.
- Los pagos llegan primero a cuenta Toku → al día siguiente transfieren a CF.
- Si un residente transfiere directo a Toku por error → contactar soporte Toku para devolución.

### Etpay (Chile, legacy)
- Reemplazado por Toku.

---

## 4. INTEGRACIÓN WEB ↔ PAYMENTS PORTAL

### Variables de entorno requeridas en Web
```
PAYMENTS_BACKGROUND_JOBS_USER: <usuario admin en portal>
PAYMENTS_BACKGROUND_JOBS_PASS: <password>
NEW_PAYMENT_PORTAL_HOST: http://localhost:3000
PAYMENTS_PORTAL_API: http://localhost:3000/api
NEW_PAYMENT_PORTAL_CF_COMPANY_TOKEN: <API key del company>
```

### Flujo de activación por comunidad
1. Crear Company en Portal de Pagos (admin).
2. Copiar API Key del company → agregar como variable de entorno en Web.
3. En Web: super admin → editar comunidad → Recaudación → habilitar pago en línea.
4. En Web: pestaña pasarelas de pago → activar pasarela deseada.

### Cómo Web envía pagos al portal
- **Online Payments Controller** (Web): inicia y crea el pago, envía `callback` (URL de retorno al usuario) y `webhook` (URL POST para notificar resultado asincrónico).
- **Online Payments Webhook Controller** (Web): recibe el webhook de Portal → actualiza estado en Web. No requiere autenticación.

### Modelo Community en Web
- `ONLINE_PAYMENT_AVAILABLE_COUNTRY_CODES`: lista de países habilitados para pago online.
- `payment_portal_setting.api_token`: JWT que identifica la oficina en Portal de Pagos.

### Migración de comunidades al nuevo portal
- Rake task: `rails data_migrations:pay:339:generate_new_payment_portal_api_keys`
- Comunidades con código CF compartido → una sola Company "CF", múltiples Offices.
- Comunidades con código propio → Company + Office propios.

---

## 5. PAGOS AUTOMÁTICOS

### Flujo de alto nivel
Diagrama documentado en Whimsical (diagrama de flujo Pago Automático).
- **High RAM**: proceso principal de cobro masivo.
- **Low RAM**: proceso alternativo para entornos restringidos.
- Usa Sidekiq para jobs en background.
- Motor principal en Web: `app/lib/online_payments/automatic_payment_execution.rb` — interactúa con API de Portal de Pagos, maneja diferentes resultados.

---

## 6. PORTAL DE OPERACIONES — RECONCILIACIÓN BANCARIA (Fintoc)

### Tech Stack
- Rails + Stimulus JS (controllers frontend).
- Fintoc API para obtener movimientos bancarios.

### Modelos Rails
- `FintocConnection`: conexión OAuth con Fintoc por institución bancaria.
- `FintocAccount`: cuentas bancarias conectadas vía Fintoc.
- `FintocBankMovement`: movimientos obtenidos de Fintoc.
- `BankReconciliation`: conciliación entre pagos CF y movimientos bancarios.

### Lógica de auto-conciliación
- Diferencia ≤ $1.000 CLP → se concilia automáticamente.
- Diferencia > $1.000 → requiere revisión manual.

### Proceso de reconciliación manual
1. Ejecutar query CF → obtener pagos del día.
2. Cargar archivos de pasarelas de pago.
3. Sistema concilia y clasifica por colores:
   - **Blanco**: sin errores.
   - **Gris**: sin cuenta bancaria (puede conciliarse igualmente).
   - **Amarillo**: error en datos (no se concilia).
   - **Naranja**: pago en pasarela pero no en Web → "pendiente", puede aparecer días después.
   - **Verde**: match de un pago naranja que ya apareció en Web (conciliado con retardo).
   - **Azul**: pago duplicado (ya no deberían aparecer).
4. Sistema genera archivos de diseño para transferencias masivas por banco.

---

## 7. PORTAL DE DEVOLUCIONES

### Objetivo
Trazabilidad y gestión de pagos recaudados. Foco en equipo de operaciones para:
- Ver dispersiones (Dispersado / Próxima dispersión / Dispersión pendiente).
- Verificar consistencia entre CF y pasarelas.

### Acceso
Módulo de Recaudación → Historial de pagos → Pestaña "En línea" → sección Dispersiones.
Solo visible para super admins.

### Integración con Web
Variables de entorno en Web:
```
PPD_API_TOKEN: <token generado en portal de devoluciones>
PDD_URL: http://localhost:3002/api
```

Generar token en portal de devoluciones:
```ruby
# Agregar JWT_SECRET al .env
User.last.generate_api_token
```

---

## 8. DASHBOARD DE TRANSACCIONES (Portal de Pagos)

### Acceso
Super admin → Soporte de pagos → Transacciones Chile / Transacciones México.

### Columnas clave
- No Orden de compra: ID externo (con "b" = viejo portal; sin letra = nuevo portal).
- Método de pago, Acceso (Web/Mobile), Tipo (manual/recurrente), Estado (pendiente/autorizada/cancelada).
- Monto con y sin comisión.

### Filtros
- Comunidad (nombre o ID), Unidad (nombre o ID), Fecha (por día).

### Acciones
- Descargar comprobante (solo pagos autorizados).
- Copiar metadata de la pasarela (útil para soporte: ver código de rechazo).

---

## 9. CÓMO INTEGRAR UNA NUEVA PASARELA (checklist)

### En Portal de Pagos
1. Rake task de setup: crear PaymentGateway + Currency + asociar.
2. Schema JSON de validación (`app/lib/payment_gateway/schemas/`).
3. Constantes de país en `app/lib/constants/countries.rb`.
4. Calculator (`app/lib/calculator/`), heredando de base.
5. Processor completo en `app/lib/processors/<gateway>/` (ver sección 2).
6. JBuilder para exponer configuración vía API.
7. Webhook en `PaymentGatewayCallbacksController`.

### En Web
1. GraphQL: mutation `enroll_card`, resolver `payment_gateways`, type `payment_gateway_type`.
2. Modelo Community: agregar país a `ONLINE_PAYMENT_AVAILABLE_COUNTRY_CODES`.
3. Helpers: logo en `invoices_helper.rb`, default en `online_payments_helper.rb`.
4. Constants: `app/lib/communities/settings/payment_gateways.rb` y `app/lib/online_payments/constants/payment_gateways.rb`.
5. Error factory: `app/lib/errors/payment_factories/`.
6. Online payments lib: `auto_numeric.rb`, `data_attributes_factory/`, `handler_payment_error/`, `payment_gateway_office_setting/builder/`, `payment_gateway_office_setting/creator/`, `processors/`.
7. Vistas HAML: `_form.html.haml`, `_<gateway>_form.html.haml`, `payment_gateways_selector/_payment_gateway.html.haml`.
8. Locales: `config/locales/views/es.yml`, `config/locales/portal_de_pagos`.
9. Residents (React Native/TS): `useHandleEnrollCard.ts`, `modulesState/index.ts`, `usePeriodControl.ts`, `constants.ts`.
10. MixPanel tracking: `app/controllers/concerns/online_payments/mix_panel.rb`.

### Si extiendes una pasarela existente a otro país
Revisa los parámetros que recibe la versión ya integrada y cumple los mismos contratos.

---

## 10. ERRORES COMUNES Y DEBUGGING

### Portal de Pagos no responde desde Web
- Verificar que Portal de Pagos esté corriendo.
- Verificar variables de entorno `NEW_PAYMENT_PORTAL_HOST` y `PAYMENTS_PORTAL_API`.
- Revisar consola de Web — si no hay logs, no hay comunicación.

### RUT faltante en comunidad
- Error al activar pago en línea si la comunidad no tiene RUT configurado.

### Token JWT expirado
- `Community.find(id).payment_portal_setting.api_token` — verificar que coincida con `Office` en portal.

### Pagos duplicados
- Históricamente aparecían en azul en el dashboard de conciliación. Ya no deberían ocurrir.

### Reintentos bloqueados por Transbank (-11)
- MASTERCARD: bloqueado tras 8 reintentos en 24h.
- VISA: bloqueado tras 16 reintentos en 30 días.
