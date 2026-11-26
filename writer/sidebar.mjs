import { parse } from '@babel/parser';

function keyName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'StringLiteral' || node?.type === 'NumericLiteral') return String(node.value);
  return null;
}

const TS_WRAPPERS = new Set([
  'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression',
  'ParenthesizedExpression', 'TypeCastExpression', 'TSInstantiationExpression',
]);

function unwrap(node) {
  while (node && TS_WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

/**
 * Evaluate the deliberately small, static subset of JavaScript used in Vocs
 * config files. This never evaluates project code. Dynamic expressions are
 * left undefined and the caller can fall back to Vocs defaults.
 */
function literal(input, bindings = new Map(), seen = new Set()) {
  const node = unwrap(input);
  if (!node) return undefined;

  if (node.type === 'Identifier' && bindings.has(node.name) && !seen.has(node.name)) {
    const nextSeen = new Set(seen);
    nextSeen.add(node.name);
    return literal(bindings.get(node.name), bindings, nextSeen);
  }
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') return node.value;
  if (node.type === 'NullLiteral') return null;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value?.cooked ?? '';
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'NumericLiteral') return -node.argument.value;
  if (node.type === 'ArrayExpression') {
    const result = [];
    for (const element of node.elements) {
      if (!element) continue;
      if (element.type === 'SpreadElement') {
        const spread = literal(element.argument, bindings, seen);
        if (Array.isArray(spread)) result.push(...spread);
      } else {
        const value = literal(element, bindings, seen);
        if (value !== undefined) result.push(value);
      }
    }
    return result;
  }
  if (node.type === 'ObjectExpression') {
    const result = {};
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        const spread = literal(property.argument, bindings, seen);
        if (spread && typeof spread === 'object' && !Array.isArray(spread)) Object.assign(result, spread);
        continue;
      }
      if (property.type !== 'ObjectProperty' || property.computed) continue;
      const name = keyName(property.key);
      if (!name) continue;
      const value = literal(property.value, bindings, seen);
      if (value !== undefined) result[name] = value;
    }
    return result;
  }
  // Only the well-known Vocs config wrapper is unwrapped. No other call runs.
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'defineConfig') {
    return literal(node.arguments?.[0], bindings, seen);
  }
  return undefined;
}

function collectBindings(program) {
  const bindings = new Map();
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const item of declaration.declarations) {
      if (item.id?.type === 'Identifier' && item.init) bindings.set(item.id.name, item.init);
    }
  }
  return bindings;
}

function defaultExport(program, bindings) {
  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration') return literal(statement.declaration, bindings);
  }
  return undefined;
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => item && typeof item === 'object' && !Array.isArray(item)).map(item => ({
    text: typeof item.text === 'string' ? item.text : (typeof item.title === 'string' ? item.title : ''),
    link: typeof item.link === 'string' ? item.link : '',
    collapsed: item.collapsed === true,
    external: item.external === true,
    items: normalizeItems(item.items),
  })).filter(item => item.text || item.link || item.items.length);
}

function normalizeSidebar(value) {
  if (Array.isArray(value)) return normalizeItems(value);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([route, group]) => ({
    text: route === '/' ? 'Home' : route,
    link: '',
    collapsed: false,
    external: false,
    items: normalizeItems(Array.isArray(group) ? group : group?.items),
  }));
}

function normalizeTopNav(value) {
  if (Array.isArray(value)) return normalizeItems(value);
  // Some configurations group links in an object. Keep the labels visible in
  // the preview, but do not invent destinations for non-link values.
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([text, group]) => ({
      text,
      link: typeof group?.link === 'string' ? group.link : '',
      collapsed: false,
      external: false,
      items: normalizeItems(Array.isArray(group) ? group : group?.items),
    }));
  }
  return [];
}

export function parseVocsConfig(source) {
  const defaults = {
    title: '',
    description: '',
    srcDir: 'src',
    logoUrl: '',
    iconUrl: '',
    banner: undefined,
    accentColor: 'light-dark(black, white)',
    colorScheme: 'light dark',
    sidebar: [],
    topNav: [],
  };
  try {
    const ast = parse(source, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: ['typescript', 'jsx', 'decorators-legacy'],
    });
    const bindings = collectBindings(ast.program);
    const config = defaultExport(ast.program, bindings);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return defaults;

    const stringValue = (key, fallback) => typeof config[key] === 'string' ? config[key] : fallback;
    const srcDir = stringValue('srcDir', 'src').replace(/^\.\//, '').replace(/\/$/, '') || 'src';
    return {
      ...defaults,
      title: stringValue('title', ''),
      description: stringValue('description', ''),
      srcDir,
      logoUrl: stringValue('logoUrl', ''),
      iconUrl: stringValue('iconUrl', ''),
      banner: config.banner,
      accentColor: stringValue('accentColor', 'light-dark(black, white)'),
      colorScheme: stringValue('colorScheme', 'light dark'),
      sidebar: normalizeSidebar(config.sidebar),
      topNav: normalizeTopNav(config.topNav),
    };
  } catch {
    return defaults;
  }
}

export function parseSidebar(source) {
  return parseVocsConfig(source).sidebar;
}
