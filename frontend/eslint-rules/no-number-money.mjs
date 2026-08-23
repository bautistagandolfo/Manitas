// Regla local: prohíbe tipar como `number` cualquier identificador cuyo
// nombre indique que guarda un importe de dinero (BLUEPRINT.md sección 9.3).
// Los importes se operan con Decimal, nunca con number: 0.1 + 0.2 en punto
// flotante no da 0.3, y eso se traduce en diferencias fantasma en la caja.

const MONEY_WORDS = new Set([
  'precio',
  'costo',
  'importe',
  'monto',
  'total',
  'subtotal',
  'descuento',
  'saldo',
  'vuelto',
  'arqueo',
  'ajuste',
  'neto',
  'iva',
  'comision',
  'senia',
  'seña',
  'credito',
  'deuda',
  'ganancia',
  'ingreso',
  'egreso',
  'gasto',
]);

function toWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\s]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

function isMoneyName(name) {
  return toWords(name).some((word) => MONEY_WORDS.has(word));
}

/** @type {import('eslint').Rule.RuleModule} */
const noNumberMoney = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prohíbe tipar importes de dinero como number en vez de Decimal',
    },
    schema: [],
    messages: {
      noNumberMoney:
        "'{{name}}' parece un importe de dinero: no lo tipes como number. Usá Decimal (BLUEPRINT.md sección 9.3).",
    },
  },
  create(context) {
    return {
      TSNumberKeyword(node) {
        const typeAnnotation = node.parent;
        if (!typeAnnotation || typeAnnotation.type !== 'TSTypeAnnotation') {
          return;
        }

        const owner = typeAnnotation.parent;
        if (!owner) {
          return;
        }

        let name;
        if (owner.type === 'Identifier') {
          name = owner.name;
        } else if (
          (owner.type === 'PropertyDefinition' || owner.type === 'TSPropertySignature') &&
          owner.key?.type === 'Identifier'
        ) {
          name = owner.key.name;
        }

        if (name && isMoneyName(name)) {
          context.report({ node: owner, messageId: 'noNumberMoney', data: { name } });
        }
      },
    };
  },
};

export default noNumberMoney;
