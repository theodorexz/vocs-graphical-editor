import { parse } from '@babel/parser';

function keyName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'StringLiteral' || node?.type === 'NumericLiteral') return String(node.value);
  return null;
}

function literal(node, bindings = new Map(), seen = new Set()) {
  if (!node) return undefined;
  if (['TSAsExpression','TSSatisfiesExpression','TSNonNullExpression','ParenthesizedExpression','TypeCastExpression'].includes(node.type)) return literal(node.expression, bindings, seen);
  if (node.type === 'Identifier' && bindings.has(node.name) && !seen.has(node.name)) {
    const nextSeen = new Set(seen); nextSeen.add(node.name);
    return literal(bindings.get(node.name), bindings, nextSeen);
  }
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') return node.value;
  if (node.type === 'NullLiteral') return null;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value?.cooked ?? '';
  if (node.type === 'ArrayExpression') return node.elements.map(value => literal(value, bindings, seen)).filter(value => value !== undefined);
  if (node.type === 'ObjectExpression') {
    const result = {};
    for (const property of node.properties) {
      if (property.type !== 'ObjectProperty' || property.computed) continue;
      const name = keyName(property.key);
      if (name) result[name] = literal(property.value, bindings, seen);
    }
    return result;
  }
  return undefined;
}

function findSidebar(node, bindings) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === 'ObjectProperty' && keyName(node.key) === 'sidebar') return literal(node.value, bindings);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'comments' || key === 'tokens') continue;
    if (Array.isArray(value)) {
      for (const child of value) { const result = findSidebar(child, bindings); if (result !== undefined) return result; }
    } else if (value && typeof value === 'object') {
      const result = findSidebar(value, bindings); if (result !== undefined) return result;
    }
  }
  return undefined;
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => item && typeof item === 'object').map(item => ({
    text: typeof item.text === 'string' ? item.text : (typeof item.title === 'string' ? item.title : ''),
    link: typeof item.link === 'string' ? item.link : '',
    collapsed: item.collapsed === true,
    external: item.external === true,
    items: normalizeItems(item.items),
  }));
}

export function parseSidebar(source) {
  try {
    const ast = parse(source, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['typescript','jsx','decorators-legacy'] });
    const bindings = new Map();
    for (const statement of ast.program.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (declaration?.type !== 'VariableDeclaration') continue;
      for (const item of declaration.declarations) if (item.id.type === 'Identifier') bindings.set(item.id.name, item.init);
    }
    const value = findSidebar(ast.program, bindings);
    if (Array.isArray(value)) return normalizeItems(value);
    if (value && typeof value === 'object') return Object.entries(value).map(([route, group]) => ({
      text: route === '/' ? 'Home' : route,
      link: '', collapsed: false, external: false,
      items: normalizeItems(Array.isArray(group) ? group : group?.items),
    }));
  } catch {}
  return [];
}
