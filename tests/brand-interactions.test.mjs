import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const themeSource = (await readFile(new URL('../brand/theme.js', import.meta.url), 'utf8')).replaceAll('export function', 'function');

function themeEnvironment({ cookie = '', saved = null, hostname = 'sajanacharya.com', blocked = false } = {}) {
  const values = new Map(saved ? [['theme', saved], ['sajan-landing-theme', saved]] : []);
  const env = {
    document: { cookie }, location: { hostname }, Event,
    window: { dispatchEvent() {} },
    localStorage: {
      getItem: (key) => { if (blocked) throw Error('storage blocked'); return values.get(key) ?? null; },
      setItem: (key, value) => { if (blocked) throw Error('storage blocked'); values.set(key, value); },
    },
  };
  vm.createContext(env);
  vm.runInContext(themeSource, env);
  return env;
}

test('first visit is light, saved preferences are respected, shared choice wins', () => {
  assert.equal(themeEnvironment().readTheme(), 'light');
  assert.equal(themeEnvironment({ saved: 'dark' }).readTheme(), 'dark');
  assert.equal(themeEnvironment({ saved: 'dark', cookie: 'sajan-theme=light' }).readTheme(), 'light');
  assert.equal(themeEnvironment({ cookie: 'sajan-theme=dark' }).readTheme('sajan-landing-theme'), 'dark');
});

test('choice is shared with only the real subdomains, and private storage still works', () => {
  for (const hostname of ['sajanacharya.com', 'reader.sajanacharya.com', 'present.sajanacharya.com', 'medcards.sajanacharya.com']) {
    const env = themeEnvironment({ hostname });
    env.saveTheme('dark');
    assert.match(env.document.cookie, /Domain=sajanacharya\.com; Path=\/; Max-Age=31536000; SameSite=Lax; Secure/);
  }
  for (const hostname of ['localhost', 'not-sajanacharya.com']) {
    const env = themeEnvironment({ hostname, blocked: true });
    env.saveTheme('dark');
    assert.equal(env.readTheme(), 'dark');
    assert.equal(env.document.cookie, '');
  }
});

const elasticSource = (await readFile(new URL('../brand/elastic.js', import.meta.url), 'utf8')).replaceAll('export function', 'function');
function elasticEnvironment({ reduced = false, link = false, closedMenu = false, rects = [{ left: 10, top: 20, right: 90, bottom: 40, width: 80, height: 20 }] } = {}) {
  const events = new Map();
  const rootEvents = new Map();
  const nodes = [];
  const frames = new Map();
  let frameId = 0;
  let visible = '1';
  const mark = {
    isConnected: true, textContent: 'Example', matches: (selector) => link && selector.split(',').map((part) => part.trim()).includes('a'),
    closest: (selector) => closedMenu && selector === 'details:not([open])' ? { querySelector: () => null } : null,
    querySelector: () => null,
    getClientRects: () => link ? [{ left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100 }] : rects,
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name) => events.delete(name),
  };
  const root = {
    scrollTop: 0, scrollLeft: 0, clientTop: 0, clientLeft: 0,
    classList: { add() {}, remove() {} }, querySelectorAll: () => [mark],
    appendChild: (node) => nodes.push(node),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (name, fn) => rootEvents.set(name, fn), removeEventListener: (name) => rootEvents.delete(name),
  };
  class Observer { observe() {} disconnect() {} }
  const env = {
    Map, Set, Array, Math, Number, NodeFilter: { SHOW_TEXT: 4 }, performance: { now: () => 0 },
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: (fn) => { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id), ResizeObserver: Observer, MutationObserver: Observer,
    window: { getComputedStyle: () => ({ fontSize: '16px', lineHeight: '20px', getPropertyValue: () => visible }) },
    document: {
      createTreeWalker: () => {
        let visited = false;
        return { currentNode: { textContent: 'Example' }, nextNode() { if (visited) return false; visited = true; return true; } };
      },
      createRange: () => ({ selectNodeContents() {}, getClientRects: () => rects }),
      createElementNS: () => ({ style: {}, attrs: {}, children: [], classList: { add() {} },
      setAttribute(key, value) { this.attrs[key] = value; }, appendChild(child) { this.children.push(child); }, remove() { this.removed = true; },
    }) },
  };
  vm.createContext(env); vm.runInContext(elasticSource, env);
  const cleanup = env.mountElasticUnderlines(root);
  return { nodes, frames, events, cleanup, root, setVisible: (value) => { visible = value; }, setMenuOpen: (value) => { closedMenu = !value; rootEvents.get('toggle')(); } };
}

test('elastic lines preserve wrapped text widths and spring in either mouse direction', () => {
  const env = elasticEnvironment({ rects: [
    { left: 10, top: 20, right: 90, bottom: 40, width: 80, height: 20 },
    { left: 10, top: 40, right: 40, bottom: 60, width: 30, height: 20 },
  ] });
  assert.deepEqual(env.nodes.map((node) => node.style.width), ['80px', '30px']);
  const path = env.nodes[0].children[0];
  env.events.get('mouseenter')({ clientX: 50, clientY: 28, movementY: 3 });
  assert.match(path.attrs.d, /40 16\.05/);
  env.events.get('mousemove')({ clientX: 50, clientY: 25, movementY: -3 });
  assert.match(path.attrs.d, /40 -12\.05/);
  env.events.get('mouseleave')();
  let sawOppositeRebound = false;
  for (let frame = 1; frame < 500 && env.frames.size; frame++) {
    const callbacks = [...env.frames.values()]; env.frames.clear();
    callbacks.forEach((fn) => fn(frame * 16));
    const y = Number(path.attrs.d.match(/, 40 (-?[\d.]+)/)[1]);
    if (y > 2.1) sawOppositeRebound = true;
  }
  assert.ok(sawOppositeRebound);
  assert.equal(env.frames.size, 0);
  env.cleanup();
  assert.ok(env.nodes.every((node) => node.removed));
  assert.equal(env.events.size, 0);
});

test('padded links underline only their text and merge fragments on each line', () => {
  const env = elasticEnvironment({ link: true, rects: [
    { left: 10, top: 20, right: 40, bottom: 40, width: 30, height: 20 },
    { left: 40, top: 20, right: 90, bottom: 40, width: 50, height: 20 },
    { left: 10, top: 40, right: 50, bottom: 60, width: 40, height: 20 },
  ] });
  assert.deepEqual(env.nodes.map((node) => node.style.width), ['80px', '40px']);
  assert.deepEqual(env.nodes.map((node) => node.style.left), ['10px', '10px']);
  env.cleanup();
});

test('closed mobile menus cannot leave floating underlines on the page', () => {
  const env = elasticEnvironment({ closedMenu: true });
  assert.equal(env.nodes.length, 0);
  env.setMenuOpen(true);
  assert.equal(env.nodes.length, 1);
  assert.equal(env.nodes[0].style.width, '80px');
  env.setMenuOpen(false);
  assert.ok(env.nodes[0].removed);
  env.cleanup();
});

test('reduced motion keeps lines static and navigation states remain visible', () => {
  const env = elasticEnvironment({ reduced: true });
  const path = env.nodes[0].children[0];
  const resting = path.attrs.d;
  env.setVisible('0'); env.events.get('focus')();
  assert.equal(env.nodes[0].style.opacity, '0');
  env.setVisible('1'); env.events.get('mouseenter')({ clientX: 50, clientY: 28, movementY: 5 });
  assert.equal(env.nodes[0].style.opacity, '1');
  assert.equal(path.attrs.d, resting);
  assert.equal(env.frames.size, 0);
  env.cleanup();
});

test('Nepal switch keeps its emblems separately animatable and supports reduced motion', async () => {
  const svg = await readFile(new URL('../brand/nepal-flag.svg', import.meta.url), 'utf8');
  const css = await readFile(new URL('../brand/brand.css', import.meta.url), 'utf8');
  for (const id of ['field', 'moon', 'sun']) assert.ok(svg.includes(`id="${id}"`));
  assert.match(css, /\[data-theme-state='dark'\] \.nepal-moon/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
