# Cómo trabajar con Claude Code en este proyecto

Runbook de uso diario. Guardalo en la raíz del repo y abrilo antes de cada
sesión.

---

## 1. Preparación (una sola vez) — Windows

1. Crear la carpeta del proyecto, por ejemplo `C:\proyectos\mvp-tienda`.
2. Descomprimir ahí el zip. En la raíz quedan `BLUEPRINT.md`,
   `MVP_SCOPE.md`, `CLAUDE.md`, `COMO_TRABAJAR.md`,
   `DECISIONES_PENDIENTES.md`, la carpeta `docs/` y la carpeta oculta
   `.claude/`.
3. Verificar que `.claude` esté (en el Explorador hay que activar
   "Elementos ocultos"; en PowerShell, `dir -Force`).
4. Instalar, si no los tenés: **Node LTS**, **Git para Windows** y **Docker
   Desktop** (para el Postgres local de la fase 00).
5. Primer commit **antes de que exista una sola línea de código**:

   ```powershell
   git config --global core.autocrlf false
   git init
   git add -A
   git commit -m "Planos del MVP: alcance, blueprint y protocolo"
   ```

   El `core.autocrlf false` importa: sin eso Git te cambia los finales de
   línea y después rompe scripts y diffs.

6. Abrir Claude Code parado en la raíz del repo y poner `/model opusplan`.

---

## 2. El ciclo de cada sesión

Siempre el mismo:

```
1. Abrir STATUS.md y ver dónde quedaste
2. Sesión nueva de Claude Code
3. UNA instrucción (una fase o un ticket)
4. Esperar
5. VERIFICAR vos (sección 4)
6. Si está bien → siguiente. Si no → corregir antes de avanzar
```

**Nunca pidas dos tickets en la misma instrucción.** Es la forma más rápida
de perder el control de lo que cambió.

---

## 3. Las instrucciones, en orden

Copiá y pegá tal cual. No hace falta explicar nada más: los archivos ya
tienen todo.

### Arranque (una sola vez)

```
Leé docs/build-protocol/00-project-setup.md y ejecutá esa fase.
```
```
Leé docs/build-protocol/01-data-model.md y ejecutá esa fase.
```
```
Leé docs/build-protocol/02-build-plan.md y ejecutá esa fase.
```
```
Leé docs/build-protocol/05-quality-gate.md y ejecutá esa fase.
```

> **La fase 02 es la que convierte los títulos del roadmap en tickets
> ejecutables** (archivos, criterio de aceptación, tests). No la saltees.

### Por cada módulo

**Antes de construirlo:**
```
Leé docs/build-protocol/06-module-spec.md y ejecutá esa fase para el módulo auth.
```

**Cada ticket, de a uno:**
```
Leé docs/build-protocol/04-ticket-execution.md y ejecutá el ticket T1.1.
```

**Tickets de plata y stock (etapas 2, 3, 4 y 5): dos sesiones separadas.**

Sesión 1 — escribe los tests sin ver ninguna implementación:
```
Leé docs/build-protocol/04a-tests-first.md y ejecutá el ticket T4.1.
```

Entre las dos sesiones, **commiteá los tests en rojo**. Así, si la sesión
que implementa toca un archivo de test, lo vas a ver en el `git diff` y vas
a saber que aflojó la expectativa en vez de arreglar el código. Decíselo
explícito al empezar la sesión 2: *"no modifiques los tests; si uno te
parece equivocado, pará y avisame"*.

Sesión 2 — implementa hasta que pasen:
```
Leé docs/build-protocol/04-ticket-execution.md y ejecutá el ticket T4.1.
```

**Cuando todos los tickets del módulo están VERDE:**
```
Leé docs/build-protocol/07-module-implementation.md y ejecutá esa fase para el módulo auth.
```
```
Leé docs/build-protocol/08-adversarial-qa.md y ejecutá esa fase para el módulo auth.
```
```
Leé docs/build-protocol/09-security-audit.md y ejecutá esa fase para el módulo auth.
```

Si el security audit encontró algo:
```
Leé docs/build-protocol/10-security-remediation.md y ejecutá esa fase para el módulo auth.
```
```
Leé docs/build-protocol/11-security-reaudit.md y ejecutá esa fase para el módulo auth.
```

**Cierre del módulo:**
```
Leé docs/build-protocol/12-production-readiness.md y ejecutá esa fase para el módulo auth.
```

Recién con eso en verde se pasa al módulo siguiente.

### Cierre del MVP

Fases 13 a 19, una por vez, en orden.

---

## 4. Qué tenés que verificar vos

Claude no puede auditarse a sí mismo. Esto es lo tuyo.

### Después de cada ticket (30 segundos)

- **`git diff --stat`** — ¿tocó solo los archivos que decía el ticket? Si
  aparecen archivos de otro módulo, algo se fue de alcance.
- ¿Actualizó `STATUS.md` y el estado del ticket en `ROADMAP.md`?

### Después de cada ticket de plata o stock (5 minutos)

Estos son los de las etapas 2, 3, 4 y 5. Abrí el diff y buscá:

- ¿La operación está **dentro de una transacción**?
- ¿Hay **bloqueo de filas** antes de leer el stock, y ordenado por id?
- ¿Los importes se operan con `Decimal` y no con `number`?
- ¿El costo se **copia** a la línea de venta, o se referencia la variante?

### Una vez por módulo (15 minutos)

- **Corré los tests vos mismo**: `npm test`. No confíes en el "tests verde"
  del reporte.
- Abrí **un test** y preguntate: *si el código estuviera mal, ¿este test
  fallaría?* Si el test mockea tanto que respondería que sí igual, no sirve.
- En los módulos de plata y stock, mirá el **resultado de Stryker** que
  reporta la fase 08. Si detecta menos del 80% de los mutantes, hay tests
  decorativos por más verde que esté todo.
- Probá la funcionalidad a mano una vez. Cinco minutos de uso real
  encuentran cosas que ningún test escrito por quien programó encuentra.

---

## 5. Señales de alarma

Si ves alguna de estas, **frená y revisá** antes de seguir:

| Señal | Qué significa |
|---|---|
| Dice "tests verde" sin mostrar la salida del comando | Puede no haberlos corrido |
| El diff es mucho más grande que el ticket | Se fue de alcance |
| Modificó o borró un test que ya existía | Prohibido por el protocolo |
| Dice "implementé una versión simplificada" | Hizo menos de lo que el ticket pedía |
| Un ticket de transacciones con tests que mockean la base | No está probando lo que importa |
| Avanzó a otro ticket sin que le pidieras | Perdiste el control del alcance |
| Interpretó algo ambiguo del blueprint en vez de frenar | Tomó una decisión que no le tocaba |

---

## 6. Sesiones y modelos

- **Sesión nueva por fase**, y por cada dos o tres tickets. Las sesiones
  largas pierden calidad: el contexto se llena y empieza a olvidar reglas.
- **Opus** para las fases de diseño: 01 (modelo de datos), 02 (plan), 06
  (spec de módulo), 13 (integración).
- **Sonnet** para ejecutar tickets (fase 04) y el resto.
- En Claude Code, `/model opusplan` hace el cambio automáticamente.

---

## 6.b Guardarraíles automáticos

En `.claude/settings.json` hay reglas que **bloquean** al agente (no le
piden, se lo impiden): no puede editar el blueprint ni los prompts del
protocolo, no puede hacer `git push`, no puede correr `rm -rf` ni resetear
la base, y no puede leer archivos `.env`. Se aplican solas. Ver
`.claude/README.md`.

**Nota sobre Windows:** el guardarraíl que bloqueaba escrituras fuera del
alcance de cada ticket es un script de bash y no está incluido en esta
versión. Ese control pasa a ser tuyo: **`git diff --stat` después de cada
ticket**. Si aparecen archivos que el ticket no mencionaba, algo se fue de
alcance. Es el mismo chequeo, hecho a mano.

---

## 7. Reglas que no se negocian

1. **Si dice BLOQUEADO, está bloqueado.** No le digas "dale, seguí igual".
   El día que lo hagas, perdiste lo que fuiste a buscar.
2. **Un ticket por vez.** La tentación de pedir tres juntos aparece cuando
   estás apurado; es justo cuando más caro sale.
3. **Ningún dato real de la tienda antes de que el backup (T0.6) esté
   andando y probado.**
4. **Los tests se escriben con el código**, nunca "después".

---

## 8. Cuando te trabes

- **Falla el mismo test dos o tres veces seguidas:** sesión nueva y
  planteale el problema desde cero. Insistir en la misma sesión con el
  contexto contaminado rara vez sale bien.
- **El blueprint no dice qué hacer:** no dejes que improvise. Se corrige el
  blueprint primero, después se implementa.
- **Aparece una regla de negocio no definida:** va a `AMBIGUITIES.md` y se
  la preguntás a tu clienta. No la decidas vos ni él.
