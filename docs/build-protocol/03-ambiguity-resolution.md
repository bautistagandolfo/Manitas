# Fase 03 — Resolución de ambigüedades

> Esta fase requiere al Product Owner / responsable de negocio. El agente
> no resuelve ambigüedades de negocio por su cuenta, aunque le "parezcan
> obvias" — pero sí puede (y debe) proponer una recomendación razonada
> para que el PO tenga que aprobar/corregir en vez de redactar desde cero.

## Paso 1 — Compilar y recomendar (agente)

Compilá en `state/AMBIGUITIES.md` todas las ambigüedades marcadas en la
sección 11 del `BLUEPRINT.md`, más las que hayan aparecido en las
especificaciones de módulo (Fase 06) o durante la construcción.

NO MODIFIQUES NINGÚN OTRO ARCHIVO. NO asumas una resolución como definitiva
ni la implementes — proponela como recomendación explícitamente marcada
como tal.

Para cada ambigüedad indicá:

- ID (AMB-1, AMB-2, ...)
- ubicación / módulo afectado
- descripción de la ambigüedad
- por qué no se puede resolver solo con el código o la documentación
  existente
- pregunta concreta y cerrada para el Product Owner (preferí opciones entre
  las que elegir, no preguntas abiertas)
- **RECOMENDACIÓN**: la opción que elegirías vos y por qué (consistencia
  con el resto del sistema, práctica estándar del rubro, menor riesgo,
  menor esfuerzo de implementación). Dejala short y concreta.
- **RIESGO DE LA RECOMENDACIÓN**: qué pasa si el PO la aprueba sin pensarlo
  y resulta ser la opción equivocada para su negocio — en una frase. Si el
  riesgo es alto (dinero, stock, datos irreversibles), decilo explícito acá
  para que no se apruebe en piloto automático.
- qué tickets (R#) o módulos quedan bloqueados hasta resolverla

Generá también una tabla de estado por ambigüedad: PENDIENTE / RESUELTA /
DIFERIDA (aceptada explícitamente como deuda documentada, con quién la
aceptó y por qué), y si la resolución final coincidió con la recomendación
propuesta o no.

Ningún R# ni módulo que dependa de una ambigüedad PENDIENTE puede pasar a
Fase 04 o Fase 07.

**Importante:** la recomendación es un insumo para decidir más rápido, no
una decisión tomada. Un PO que solo contesta "sí, dale con todas las
recomendadas" sin leerlas está, en la práctica, dejando que el agente
decida — que es exactamente lo que esta fase existe para evitar. Marcá con
una advertencia visible las ambigüedades de riesgo ALTO (dinero, stock,
auth, datos irreversibles) para que no se aprueben en bloque sin leerlas
una por una.

## Paso 2 — Resolver (humano + agente)

Una vez que el Product Owner responde, actualizá `state/AMBIGUITIES.md`
con sus respuestas:

```
Actualizá state/AMBIGUITIES.md con las respuestas del Product Owner:
[pegar respuestas — puede ser "apruebo la recomendación de AMB-2 y AMB-5,
para AMB-3 la respuesta es distinta: ..."]
Marcá cada una como RESUELTA o DIFERIDA según corresponda, indicá si
coincidió con la recomendación propuesta, y liberá los R#/módulos que
quedaron desbloqueados.
```

---

> **Al finalizar:** agregá una fila a `state/STATUS.md`. Si quedan
> ambigüedades PENDIENTES, el resultado es BLOQUEADO para los R#/módulos
> que dependen de ellas (el resto de la fase puede seguir su curso).
