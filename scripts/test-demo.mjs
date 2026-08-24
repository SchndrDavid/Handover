import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const DOCS = new URL('../docs/', import.meta.url);
const seed = readFileSync(new URL('sample-seed.js', DOCS), 'utf8');
const demo = readFileSync(new URL('demo.js', DOCS), 'utf8');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://handover.schndrdavid.eu/',
  runScripts: 'outside-only',
});
const w = dom.window;
// jsdom has no fetch/Response; demo.js only needs them to exist.
w.Response = Response;
w.Request = Request;
w.fetch = async (u) => { throw new Error('unexpected real network fetch: ' + u); };
w.eval(seed);
w.eval(demo);

const api = (p, o) => w.fetch('' + p, o).then(async r => {
  const body = await r.json();
  if (!r.ok) throw new Error(body.detail || r.statusText);
  return body;
});

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
};

const cfg = await api('/api/config');
check('config', cfg.root === 'demo' && cfg.readonly === false && cfg.disk.total > 0);

let root = await api('/api/list?path=');
check('root listing', root.entries.length === 4, root.entries.map(e => e.name).join(', '));
check('dirs sort first', root.entries[0].dir && !root.entries.at(-1).dir);
check('root crumbs empty', root.crumbs.length === 0);

const docs = await api('/api/list?path=' + encodeURIComponent('Documents'));
check('subfolder listing', docs.entries.length === 4);
check('mime passed through', docs.entries.some(e => e.mime === 'text/markdown'));

const deep = await api('/api/list?path=' + encodeURIComponent('Archive/2026-08'));
check('nested crumbs', deep.crumbs.length === 2 && deep.crumbs[1].path === 'Archive/2026-08');

const tree = await api('/api/tree?path=');
check('tree returns only dirs', tree.length === 3 && tree.every(n => !('mime' in n)));

const tree2 = await api('/api/tree?path=&depth=2');
check('tree depth 2', tree2.find(n => n.name === 'Archive').children.length === 1);

const du = await api('/api/du?path=' + encodeURIComponent('Documents'));
check('du sums files', du.size > 2000 && du.size < 4000, du.size + ' B');

const s1 = await api('/api/search?q=md&path=');
check('search finds by substring', s1.entries.length === 2, s1.entries.map(e => e.name).join(', '));
const s2 = await api('/api/search?q=a&path=');
check('search ignores 1-char query', s2.entries.length === 0);
const s3 = await api('/api/search?q=change&path=' + encodeURIComponent('Archive'));
check('search is scoped', s3.entries.length === 1);

await api('/api/mkdir', { method: 'POST', headers: {}, body: JSON.stringify({ path: '', name: 'Inbox' }) });
root = await api('/api/list?path=');
check('mkdir', root.entries.some(e => e.name === 'Inbox' && e.dir));

await api('/api/mkdir', { method: 'POST', body: JSON.stringify({ path: '', name: 'Inbox' }) });
root = await api('/api/list?path=');
check('mkdir dedupes', root.entries.some(e => e.name === 'Inbox-2'));

await api('/api/textfile', { method: 'POST', body: JSON.stringify({ path: 'Inbox', name: 'hello', content: 'ahoj světe' }) });
const t = await api('/api/text/' + encodeURI('Inbox/hello.txt'));
check('textfile + read back', t.content === 'ahoj světe');
const inbox = await api('/api/list?path=Inbox');
check('textfile got .txt suffix', inbox.entries[0].name === 'hello.txt');

await api('/api/rename', { method: 'POST', body: JSON.stringify({ path: 'Inbox', name: 'Drop' }) });
const drop = await api('/api/list?path=Drop');
check('rename moves children too', drop.entries.length === 1 && drop.entries[0].path === 'Drop/hello.txt');

let clash = null;
try { await api('/api/rename', { method: 'POST', body: JSON.stringify({ path: 'Drop', name: 'Photos' }) }); }
catch (e) { clash = e.message; }
check('rename onto existing name is rejected', clash !== null, clash || '');

let bad = null;
try { await api('/api/rename', { method: 'POST', body: JSON.stringify({ path: 'Drop', name: 'a/b' }) }); }
catch (e) { bad = e.message; }
check('slash in name is rejected', bad !== null, bad || '');

await api('/api/move', { method: 'POST', body: JSON.stringify({ paths: ['Drop'], dest: 'Archive' }) });
const arch = await api('/api/list?path=Archive');
check('move', arch.entries.some(e => e.name === 'Drop'));
const moved = await api('/api/text/' + encodeURI('Archive/Drop/hello.txt'));
check('moved child still readable', moved.content === 'ahoj světe');

const before = (await api('/api/list?path=Archive')).entries.length;
await api('/api/move', { method: 'POST', body: JSON.stringify({ paths: ['Archive'], dest: 'Archive/Drop' }) });
check('folder cannot be moved into itself',
  (await api('/api/list?path=Archive')).entries.length === before);

await api('/api/delete', { method: 'POST', body: JSON.stringify({ paths: ['Archive/Drop'] }) });
check('delete removes tree', !(await api('/api/list?path=Archive')).entries.some(e => e.name === 'Drop'));
let gone = null;
try { await api('/api/text/' + encodeURI('Archive/Drop/hello.txt')); } catch (e) { gone = e.message; }
check('deleted child is gone', gone !== null);

// upload through the XHR path the app actually uses
const fd = new w.FormData();
fd.append('files', new w.File(['x'.repeat(2048)], 'holiday/beach.jpg', { type: 'image/jpeg' }), 'holiday/beach.jpg');
fd.append('files', new w.File(['plain'], 'read me.txt', { type: 'text/plain' }), 'read me.txt');
fd.append('path', 'Photos');

const ticks = [];
const done = await new Promise((res, rej) => {
  const x = new w.XMLHttpRequest();
  x.upload.onprogress = ev => ticks.push(ev.loaded / ev.total);
  x.onload = () => res(x.status);
  x.onerror = () => rej(new Error('xhr error'));
  x.open('POST', '/api/upload');
  x.send(fd);
});
check('upload returns 200', done === 200);
check('progress events fired', ticks.length > 1 && ticks.at(-1) === 1, ticks.length + ' ticks');
const photos = await api('/api/list?path=Photos');
check('upload created subfolder from path', photos.entries.some(e => e.name === 'holiday' && e.dir));
check('upload kept spaces in name', photos.entries.some(e => e.name === 'read me.txt'));
const holiday = await api('/api/list?path=' + encodeURIComponent('Photos/holiday'));
check('uploaded file lands inside', holiday.entries[0].name === 'beach.jpg' && holiday.entries[0].size === 2048);

const after = await api('/api/config');
check('disk usage moved with upload', after.disk.free < cfg.disk.free);

let missing = null;
try { await api('/api/list?path=' + encodeURIComponent('../etc')); } catch (e) { missing = e.message; }
check('path outside the tree 404s rather than escaping', missing !== null, missing || '');

console.log(fails ? `\n${fails} failing` : '\nall green');
process.exit(fails ? 1 : 0);
