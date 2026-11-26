import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const filename = fileURLToPath(new URL(`../client/${name}.ts`, import.meta.url));
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(
    specifier => load(specifier.replace(/^\.\//, '')), module, module.exports,
  );
  cache.set(name, module.exports);
  return module.exports;
}
const { parseFileLink, parseWorkspaceRoute, resolveFileLink } = load('file-link');
const { prepareLocalReveal, warmLocalReveal } = load('reveal');
const route = { serverId: 'local', workspaceId: 'workspace' };
const target = parseFileLink('F:/demo/视频.mp4');
function bridge(serverId = 'local') {
  return {
    platform: 'win32',
    invoke: async command => { assert.equal(command, 'desktop_daemon_status'); return { serverId }; },
    editor: {
      listTargets: async () => { assert.fail('File reveal must not enumerate installed editors'); },
      openTarget: async () => { assert.fail('Preparing a menu must not open any file'); },
    },
  };
}

test('Windows links retain spaces, Unicode and literal encoded fragments; line markers are removed', () => {
  for (const [input, expected] of [
    ['F:/demo/视频.mp4', 'F:/demo/视频.mp4'],
    ['/F:/My%20Files/report.pdf', 'F:/My Files/report.pdf'],
    ['F:\\demo\\slides.pptx', 'F:/demo/slides.pptx'],
    ['file:///F:/My%20Files/report.pdf#page=3', 'F:/My Files/report.pdf'],
    ['file://localhost/F:/demo/main.ts#L12C3-L15', 'F:/demo/main.ts'],
    ['F:/demo/main.ts:42:8', 'F:/demo/main.ts'],
    ['F:/demo/a%23L12.pdf', 'F:/demo/a#L12.pdf'],
    ['F:/demo/rate%25.txt', 'F:/demo/rate%.txt'],
  ]) assert.equal(parseFileLink(input)?.path, expected, input);
});

test('web links, protocols, network paths and non-file references are excluded', () => {
  for (const input of ['https://example.com/video.mp4', 'mailto:a@b.com', 'javascript:alert(1)', 'data:text/html,x', 'file://remote/share/file.pdf', '//remote/share/file.pdf', '\\\\remote\\share\\file.pdf', 'C:relative.txt', '#L2', 'https%3A%2F%2Fexample.com%2Fa.pdf', 'report.pdf\0', 'plainword']) {
    assert.equal(parseFileLink(input), null, input);
  }
});

test('relative paths resolve only with a known workspace and never guess Windows paths from Unix paths', () => {
  assert.equal(resolveFileLink(parseFileLink('../renders/intro.mp4'), 'F:\\project\\demo', 'win32'), 'F:/project/renders/intro.mp4');
  assert.equal(resolveFileLink(parseFileLink('report.pdf'), null, 'win32'), null);
  assert.equal(resolveFileLink(parseFileLink('/mnt/f/project/report.pdf'), 'F:/project', 'win32'), null);
  assert.equal(resolveFileLink(parseFileLink('C:/file.pdf'), '/project', 'linux'), null);
  assert.equal(resolveFileLink(parseFileLink('~/Downloads/slides.pptx'), null, 'darwin'), '~/Downloads/slides.pptx');
  assert.equal(resolveFileLink(parseFileLink('F:/demo/report.pdf:stream'), null, 'win32'), null);
});

test('workspace routes identify the exact host and reject unrelated routes', () => {
  assert.deepEqual(parseWorkspaceRoute('/h/local/workspace/workspace?open=agent:one'), route);
  for (const path of ['/settings', '/h/local', '/h/local/workspace/', '/h/local/workspace/b64_legacy']) {
    assert.equal(parseWorkspaceRoute(path), null);
  }
});

test('a local file uses the desktop file-manager target without executing it during preparation', async () => {
  const result = await prepareLocalReveal({ bridge: bridge(), route, target, readDirectory: async () => { assert.fail('Absolute links need no workspace lookup'); } });
  assert.deepEqual(result, { ready: true, input: { editorId: 'explorer', workspacePath: 'F:\\demo\\视频.mp4', filePath: 'F:\\demo\\视频.mp4' } });
});

test('a local directory opens in the manager and relative files use the selected workspace', async () => {
  const readDirectory = async selected => { assert.deepEqual(selected, route); return 'F:/project'; };
  const directory = await prepareLocalReveal({ bridge: bridge(), route, target: parseFileLink('renders/'), readDirectory });
  assert.deepEqual(directory, { ready: true, input: { editorId: 'explorer', workspacePath: 'F:\\project\\renders' } });
  const file = await prepareLocalReveal({ bridge: bridge(), route, target: parseFileLink('slides.pptx'), readDirectory });
  assert.equal(file.input.filePath, 'F:\\project\\slides.pptx');
});

test('remote and unknown contexts never query a workspace or an opener', async () => {
  const desktop = bridge();
  desktop.editor.listTargets = async () => assert.fail('Remote paths must not query launch targets');
  const readDirectory = async () => assert.fail('Remote paths must not query local workspace contents');
  assert.deepEqual(await prepareLocalReveal({ bridge: desktop, route: { ...route, serverId: 'remote' }, target, readDirectory }), { ready: false, reason: 'remote' });
  assert.deepEqual(await prepareLocalReveal({ bridge: desktop, route: null, target, readDirectory }), { ready: false, reason: 'unknown-workspace' });
  assert.deepEqual(await prepareLocalReveal({ bridge: {}, route, target, readDirectory }), { ready: false, reason: 'unavailable' });
});

test('a failed identity query is retried rather than cached', async () => {
  const desktop = bridge();
  let attempts = 0;
  desktop.invoke = async () => {
    if (++attempts === 1) throw new Error('Desktop unavailable');
    return { serverId: 'local' };
  };
  await assert.rejects(warmLocalReveal(desktop), /Desktop unavailable/);
  const result = await prepareLocalReveal({ bridge: desktop, route, target, readDirectory: async () => null });
  assert.equal(result.ready, true);
  assert.equal(attempts, 2);
});

test('startup and concurrent menus share one identity request; repeated menus reuse it', async () => {
  const desktop = bridge();
  let finish;
  let calls = 0;
  desktop.invoke = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const warmed = warmLocalReveal(desktop);
  const prepare = () => prepareLocalReveal({ bridge: desktop, route, target, readDirectory: async () => null });
  const first = prepare();
  const second = prepare();
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ serverId: 'local' });
  await warmed;
  assert.equal((await first).ready, true);
  assert.equal((await second).ready, true);
  assert.equal((await prepare()).ready, true);
  assert.equal(calls, 1);
});

test('missing identity is retried, and confirmed identities do not leak across bridges', async () => {
  const desktop = bridge();
  let calls = 0;
  desktop.invoke = async () => ({ serverId: ++calls === 1 ? '   ' : 'local' });
  const prepare = selected => prepareLocalReveal({ bridge: selected, route, target, readDirectory: async () => null });
  assert.deepEqual(await prepare(desktop), { ready: false, reason: 'unavailable' });
  assert.equal((await prepare(desktop)).ready, true);
  assert.equal(calls, 2);
  assert.deepEqual(await prepare(bridge('other-local-host')), { ready: false, reason: 'remote' });
});

test('cached identity still rejects each remote route before reading a workspace', async () => {
  const desktop = bridge();
  let calls = 0;
  desktop.invoke = async () => { calls++; return { serverId: 'local' }; };
  await warmLocalReveal(desktop);
  const result = await prepareLocalReveal({
    bridge: desktop, route: { ...route, serverId: 'remote' },
    target: parseFileLink('./report.pdf'),
    readDirectory: async () => assert.fail('A cached local identity cannot authorize a remote path'),
  });
  assert.deepEqual(result, { ready: false, reason: 'remote' });
  assert.equal(calls, 1);
});

test('built-in file-manager IDs are selected without enumerating editors', async () => {
  for (const [platform, editorId, filePath] of [
    ['win32', 'explorer', 'F:/demo/report.pdf'],
    ['darwin', 'finder', '/demo/report.pdf'],
    ['linux', 'file-manager', '/demo/report.pdf'],
  ]) {
    const desktop = { ...bridge(), platform };
    const result = await prepareLocalReveal({ bridge: desktop, route, target: parseFileLink(filePath), readDirectory: async () => null });
    assert.equal(result.ready, true);
    assert.equal(result.input.editorId, editorId);
  }
  const unsupported = { ...bridge(), platform: 'unknown' };
  unsupported.invoke = async () => assert.fail('Unsupported clients should not query the desktop');
  assert.deepEqual(await prepareLocalReveal({ bridge: unsupported, route, target, readDirectory: async () => null }), { ready: false, reason: 'unavailable' });
});
