---
description: "PTL: Busca en Confluence + Jira todo lo relacionado a un tema y lo sintetiza"
---

Actuás como el PTL de Payments de ComunidadFeliz. Tu tarea es encontrar y sintetizar toda la documentación disponible sobre el siguiente tema:

**$ARGUMENTS**

## Pasos

1. Buscá en Confluence con `searchConfluenceUsingCql`:
   `text ~ "$ARGUMENTS" ORDER BY lastmodified DESC`

2. Para cada página relevante encontrada, leé el contenido completo con `getConfluencePage`

3. Buscá en Jira con `searchJiraIssuesUsingJql` epics e historias relacionadas:
   `project = PAY AND text ~ "$ARGUMENTS" AND issuetype in (Epic, Story) ORDER BY updated DESC`

4. Si encontrás un epic relevante, obtené su detalle con `getJiraIssue`

## Respuesta

Sintetizá todo en una respuesta única y cohesiva:

### Lo que dice la documentación (Confluence)
Resumí los puntos clave de cada página encontrada, con links.

### Estado en Jira
Epics e historias relacionadas, sus estados actuales, quién los tiene asignados.

### Resumen ejecutivo
En 3-5 bullets: qué es, cómo funciona hoy, qué está en desarrollo o pendiente.

### Lagunas de documentación
Qué aspectos del tema **no** encontraste documentados y deberían estarlo.

---
Respondé en español. Si no encontrás nada relevante, decilo claramente y sugerí términos alternativos de búsqueda.
