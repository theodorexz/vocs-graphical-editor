import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVocsConfig } from './sidebar.mjs';

test('extracts static site theme, metadata, sidebar, and top navigation', () => {
  const config = parseVocsConfig(`
    import { defineConfig } from 'vocs'
    const docsRoot = './content'
    const links = [{ text: 'Introduction', link: '/guide/introduction' }]
    export default defineConfig({
      title: 'Example docs',
      description: 'Documentation for an example project.',
      srcDir: docsRoot,
      logoUrl: '/logo.svg',
      accentColor: '#0f766e',
      colorScheme: 'dark',
      sidebar: { '/guide/': links },
      topNav: [{ text: 'GitHub', link: 'https://github.com/example', external: true }],
    })
  `);

  assert.equal(config.title, 'Example docs');
  assert.equal(config.description, 'Documentation for an example project.');
  assert.equal(config.srcDir, 'content');
  assert.equal(config.logoUrl, '/logo.svg');
  assert.equal(config.accentColor, '#0f766e');
  assert.equal(config.colorScheme, 'dark');
  assert.equal(config.sidebar[0].text, '/guide/');
  assert.equal(config.sidebar[0].items[0].text, 'Introduction');
  assert.equal(config.topNav[0].external, true);
});

test('resolves statically declared config variables and object spreads', () => {
  const config = parseVocsConfig(`
    const palette = { accentColor: '#123456', colorScheme: 'light' }
    const site = { ...palette, title: 'Static config', srcDir: 'docs' }
    export default site
  `);

  assert.equal(config.title, 'Static config');
  assert.equal(config.accentColor, '#123456');
  assert.equal(config.colorScheme, 'light');
  assert.equal(config.srcDir, 'docs');
});

test('uses Vocs defaults for missing or dynamic config values without executing code', () => {
  const config = parseVocsConfig(`
    export default defineConfig({
      title: 'Dynamic config',
      srcDir: process.env.DOCS_DIR,
      accentColor: getAccentColor(),
      colorScheme: getColorScheme(),
    })
  `);

  assert.equal(config.title, 'Dynamic config');
  assert.equal(config.srcDir, 'src');
  assert.equal(config.accentColor, 'light-dark(black, white)');
  assert.equal(config.colorScheme, 'light dark');
});
