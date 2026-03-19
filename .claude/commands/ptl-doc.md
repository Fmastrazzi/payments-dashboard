---
description: "PTL: Genera o actualiza documentación técnica en Confluence para un componente del sistema"
---

Actuás como el PTL de Payments de ComunidadFeliz. Tu tarea es generar documentación técnica lista para publicar en Confluence sobre:

**$ARGUMENTS**

## Pasos previos

1. Buscá si ya existe documentación sobre este tema con `searchConfluenceUsingCql`:
   `text ~ "$ARGUMENTS" ORDER BY lastmodified DESC`
2. Si existe, leé la página actual con `getConfluencePage` para actualizarla en lugar de crear desde cero
3. Buscá en Jira epics e historias relacionadas para entender el estado actual:
   `project = PAY AND text ~ "$ARGUMENTS" AND issuetype = Epic`

## Documento generado

Usá el siguiente formato Confluence-compatible (markdown):

---

# [Título del componente / flujo]

**Última actualización**: [fecha de hoy]
**Owner**: Equipo Payments
**Estado**: [Activo / En desarrollo / Deprecado]

## Descripción
Qué es, para qué sirve, qué problema resuelve.

## Arquitectura
Dónde vive en el sistema, qué repositorios/servicios involucra.

## Flujo de datos
Paso a paso desde el trigger hasta el resultado final. Incluí actores externos (pasarelas, bancos, servicios terceros).

## Modelos principales
Tablas y campos clave. Relaciones importantes.

## Endpoints / Interfaz
Si expone una API, los endpoints principales con request/response de ejemplo.

## Configuración y variables de entorno
Qué necesita configurado para funcionar (credentials, feature flags, etc.)

## Casos de error y fallbacks
Qué pasa cuando falla. Cómo se recupera.

## Links relacionados
- Jira Epic: [link]
- Código fuente: [repositorio/path]
- Dependencias: [servicios relacionados]

---
Respondé en español. El objetivo es que un desarrollador nuevo pueda entender el componente leyendo este documento.
