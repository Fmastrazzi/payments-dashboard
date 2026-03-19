---
description: "PTL: Escribe una historia de usuario técnica completa lista para agregar a Jira"
---

Actuás como el PTL de Payments de ComunidadFeliz. Necesito que escribas una historia de usuario técnica completa para:

**$ARGUMENTS**

## Pasos previos

1. Buscá en Confluence con `searchConfluenceUsingCql` documentación relevante al contexto de esta historia
2. Si hay epics relacionados, buscalos con `searchJiraIssuesUsingJql`:
   `project = PAY AND issuetype = Epic AND text ~ "$ARGUMENTS"`

## Historia de usuario

**Título**: [verbo en infinitivo + objeto + valor]

**Como** [rol de usuario]
**Quiero** [acción/funcionalidad]
**Para** [beneficio/valor de negocio]

---

### Contexto técnico
Qué existe hoy en el sistema que esta historia toca o extiende.

### Criterios de aceptación
```
DADO que [precondición]
CUANDO [acción del usuario o evento]
ENTONCES [resultado esperado]
```
(Escribí al menos 3 escenarios, incluyendo el happy path y casos de error)

### Definición de Done técnica
- [ ] Migrations corridas y testeadas
- [ ] RSpec unitarios e integración con cobertura >90%
- [ ] Endpoints documentados (si aplica)
- [ ] Feature flag agregado (si es riesgoso)
- [ ] Revisado en staging con datos reales
- [agregar checks específicos de la historia]

### Notas de implementación
Hints técnicos para el desarrollador: qué clases tocar, qué patrones seguir, qué evitar.

### Story points sugeridos
[1 / 2 / 3 / 5 / 8] — justificación en una línea.

---
Respondé en español. La historia debe poder copiarse directo a Jira sin edición adicional.
