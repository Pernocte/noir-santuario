'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const contactData = [{ codigo: '2', nombre: 'Ana', foto: '/a.png' }, { codigo: '3', nombre: 'Bea', foto: '/b.png' }];
async function fixture(t, handler) {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const { window } = dom, alerts = [], calls = [];
    await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
    window.AbortController = AbortController; window.AbortSignal = AbortSignal;
    window.alert = value => alerts.push(value); window.confirm = () => true;
    window.fetch = async (url, options) => {
        const route = new URL(url, 'http://localhost'); calls.push([route.pathname + route.search, options]);
        let data = await handler?.(route, options);
        if (data === undefined) {
            if (route.pathname === '/api/login') data = { user: { codigo: '1', nombre: 'Tester', rol: 'admin', saldo: '100.00' } };
            else if (route.pathname === '/api/evento') data = { titulo: 'Evento', fecha: 'Viernes', hora: '20:00', descripcion: '' };
            else if (route.pathname === '/api/contactos/1') data = contactData;
            else if (route.pathname.startsWith('/api/mensajes/')) data = { state: [], messages: [], hasOlder: false };
            else if (route.pathname.startsWith('/api/items/')) data = [];
            else data = { success: true, message: 'OK' };
        }
        return data instanceof Response ? data : new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    window.eval(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    const $ = id => window.document.getElementById(id);
    $('access-code').value = 'test'; $('verify-btn').click(); await tick();
    return { window, $, alerts, calls, profile: async () => { window.document.querySelector('[data-target="sec-chat"]').click(); await tick(); }, open: async id => { window.document.querySelector(`[data-codigo="${id}"]`).click(); await tick(); } };
}
test('slow old gallery response cannot overwrite the selected category', async t => {
    const slow = deferred();
    const f = await fixture(t, route => route.pathname === '/api/items/juguetes' ? slow.promise : route.pathname === '/api/items/lenceria' ? [{ id: 2, nombre: "L'Art <img src=x onerror=alert(1)>", precio: 10, imagen: '/a.png' }] : undefined);
    f.window.document.querySelector('[data-target="sec-mercancia"]').click(); await tick();
    f.window.cambiarSubCategoria('lenceria'); await tick();
    slow.resolve([{ id: 1, nombre: 'OLD', precio: 1, imagen: '/b.png' }]); await tick();
    assert.match(f.$('grid-mercancia-dinamico').textContent, /L'Art/); assert.ok(!f.$('grid-mercancia-dinamico').textContent.includes('OLD'));
    assert.equal(f.$('grid-mercancia-dinamico').querySelectorAll('img').length, 1);
    assert.ok(f.window.document.querySelector('[data-subcat="lenceria"]').classList.contains('active'));
});
test('gallery HTTP failure offers retry and recovers', async t => {
    let count = 0;
    const f = await fixture(t, route => route.pathname === '/api/items/modelos' ? (++count === 1 ? new Response(JSON.stringify({ error: 'Offline' }), { status: 500 }) : [{ id: 1, nombre: 'Modelo', precio: 5, imagen: '/a.png' }]) : undefined);
    f.window.document.querySelector('[data-target="sec-modelos"]').click(); await tick();
    assert.match(f.$('grid-modelos').textContent, /Reintentar/); f.$('grid-modelos').querySelector('button').click(); await tick();
    assert.match(f.$('grid-modelos').textContent, /Modelo/);
});
test('slow chat A never appears in chat B', async t => {
    const slow = deferred();
    const f = await fixture(t, route => route.pathname === '/api/mensajes/1/2' ? slow.promise : route.pathname === '/api/mensajes/1/3' ? { state: [{ id: 20, leido: 0 }], messages: [{ id: 20, mensaje: 'Bea only', remitente_codigo: '3', leido: 0 }] } : undefined);
    await f.profile(); await f.open('2'); await f.open('3');
    slow.resolve({ state: [{ id: 10, leido: 0 }], messages: [{ id: 10, mensaje: 'Ana only', remitente_codigo: '2', leido: 0 }] }); await tick();
    assert.match(f.$('chat-box').textContent, /Bea only/); assert.ok(!f.$('chat-box').textContent.includes('Ana only'));
});
test('failed send keeps a recoverable failed bubble with no confirmation tick', async t => {
    const f = await fixture(t, (route, options) => route.pathname === '/api/mensajes' && options.method === 'POST' ? new Response(JSON.stringify({ error: 'Send failed' }), { status: 500 }) : undefined);
    await f.profile(); await f.open('2'); f.$('chat-input').value = 'Keep this draft'; f.$('send-msg-btn').click(); await tick();
    assert.match(f.$('chat-box').textContent, /Keep this draft/); assert.match(f.$('chat-box').textContent, /No se confirmó/); assert.equal(f.$('chat-box').querySelectorAll('.message-tick').length, 0);
    assert.match(f.$('toast-region').textContent, /Send failed/); assert.equal(f.$('send-msg-btn').disabled, false);
});
test('read receipts update existing bubbles and text is inert', async t => {
    let reads = 0;
    const f = await fixture(t, route => route.pathname === '/api/mensajes/1/2' ? { state: [{ id: 10, leido: reads++ ? 1 : 0 }], messages: route.searchParams.get('after') === '0' ? [{ id: 10, mensaje: '<img src=x onerror=alert(1)>', remitente_codigo: '1', leido: 0 }] : [] } : undefined);
    await f.profile(); await f.open('2');
    const original = f.$('chat-box').querySelector('.msg-bubble'); assert.equal(original.querySelector('img'), null); assert.equal(original.querySelector('.message-tick').textContent, '✓');
    f.window.document.dispatchEvent(new f.window.Event('visibilitychange')); await tick();
    assert.equal(f.$('chat-box').querySelector('.msg-bubble'), original); assert.equal(original.querySelector('.message-tick').textContent, '✓✓');
});
test('double send is serialized and recipient is captured before navigation', async t => {
    const pending = deferred();
    const f = await fixture(t, (route, options) => route.pathname === '/api/mensajes' && options.method === 'POST' ? pending.promise : undefined);
    await f.profile(); await f.open('2');
    f.$('chat-input').value = 'hello'; f.$('send-msg-btn').click();
    f.$('chat-input').dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter' }));
    await f.open('3'); pending.resolve({ success: true }); await tick();
    const posts = f.calls.filter(([route, opts]) => route === '/api/mensajes' && opts.method === 'POST');
    assert.equal(posts.length, 1); assert.equal(JSON.parse(posts[0][1].body).destinatario, '2'); assert.equal(f.$('active-chat-name').textContent, 'Bea');
});
test('returning to mobile contacts stops reading the previous chat', async t => {
    const f = await fixture(t); f.window.innerWidth = 390;
    await f.profile(); await f.open('2');
    f.$('back-to-contacts-btn').click(); await tick();
    const before = f.calls.filter(([route]) => route.startsWith('/api/mensajes/')).length;
    f.window.document.dispatchEvent(new f.window.Event('visibilitychange')); await tick();
    assert.equal(f.calls.filter(([route]) => route.startsWith('/api/mensajes/')).length, before);
    assert.ok(!f.$('mobile-chat-main').classList.contains('active-mobile')); assert.equal(f.$('send-msg-btn').disabled, true);
});
test('older history is prepended without losing recent messages', async t => {
    const f = await fixture(t, route => route.pathname === '/api/mensajes/1/2' ? { state: [{ id: 1, leido: 1 }, { id: 2, leido: 1 }], messages: [{ id: route.searchParams.has('before') ? 1 : 2, mensaje: route.searchParams.has('before') ? 'Older' : 'Recent', remitente_codigo: '2', leido: 1 }] } : undefined);
    await f.profile(); await f.open('2');
    const button = f.window.document.querySelector('.load-older'); assert.equal(button.hidden, false); button.click(); await tick();
    assert.deepEqual([...f.$('chat-box').querySelectorAll('.message-text')].map(node => node.textContent), ['Older', 'Recent']); assert.equal(button.hidden, true);
});
test('switching chat discards the previous pending photo without sending to a new recipient', async t => {
    const sent = [];
    const f = await fixture(t, (route, options) => { if (route.pathname === '/api/mensajes' && options.method === 'POST') { sent.push(JSON.parse(options.body)); return { success: true }; } });
    const ready = deferred();
    f.window.URL.createObjectURL = () => 'blob:test'; f.window.URL.revokeObjectURL = () => {};
    f.window.Image = class { naturalWidth = 2000; naturalHeight = 1000; set src(value) { ready.promise.then(() => this.onload()); } };
    f.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
    f.window.HTMLCanvasElement.prototype.toBlob = callback => callback(new f.window.Blob(['abc'], { type: 'image/jpeg' }));
    await f.profile(); await f.open('2');
    const file = new f.window.File(['test'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(f.$('chat-img-input'), 'files', { configurable: true, value: [file] });
    f.$('chat-img-input').dispatchEvent(new f.window.Event('change'));
    await f.open('3'); ready.resolve(); await tick();
    assert.equal(sent.length, 0); assert.equal(f.$('attachment-preview').hidden, true); assert.equal(f.$('chat-img-input').value, '');
});
test('gallery cache avoids repeated loads and explicit refresh fetches again', async t => {
    const f = await fixture(t, route => route.pathname === '/api/items/juguetes' ? [{ id: 1, nombre: 'Prueba', precio: 5, imagen: '/full.png', miniatura: '/thumb.webp' }] : undefined);
    f.window.document.querySelector('[data-target="sec-mercancia"]').click(); await tick();
    assert.equal(f.$('grid-mercancia-dinamico').querySelector('img').getAttribute('src'), '/thumb.webp');
    await f.profile(); f.window.document.querySelector('[data-target="sec-mercancia"]').click(); await tick();
    assert.equal(f.calls.filter(([route]) => route === '/api/items/juguetes').length, 1);
    f.$('refresh-catalog-btn').click(); await tick(); assert.equal(f.calls.filter(([route]) => route === '/api/items/juguetes').length, 2);
});
test('friend nick lookup adds only the selected user and opens conversation', async t => {
    const f = await fixture(t, route => route.pathname === '/api/usuarios/buscar' ? { codigo: '3', nombre: 'Bea', foto: '/b.png' } : undefined);
    await f.profile(); f.$('add-contact-btn').click(); f.$('friend-nick').value = '@Bea';
    f.$('friend-search-form').dispatchEvent(new f.window.Event('submit', { cancelable: true })); await tick();
    assert.match(f.$('friend-result').textContent, /Agregar y conversar/);
    f.$('friend-result').querySelector('button').click(); await tick();
    const post = f.calls.find(([route, opts]) => route === '/api/contactos' && opts.method === 'POST');
    assert.equal(JSON.parse(post[1].body).aliasContacto, 'Bea'); assert.equal(f.$('active-chat-name').textContent, 'Bea');
});
test('unread badges, previews and conversation filtering use contact data', async t => {
    const f = await fixture(t, route => route.pathname === '/api/contactos/1' ? [{ codigo: '2', nombre: 'Ana', no_leidos: 4, ultimo_mensaje: 'Hasta mañana' }, { codigo: '3', nombre: 'Bea', no_leidos: 0 }] : undefined);
    await f.profile(); assert.equal(f.window.document.querySelector('.unread-total').textContent, '4'); assert.match(f.$('contact-list-container').textContent, /Hasta mañana/);
    f.$('contact-search').value = 'bea'; f.$('contact-search').dispatchEvent(new f.window.Event('input'));
    assert.equal(f.window.document.querySelector('[data-codigo="2"]').hidden, true); assert.equal(f.window.document.querySelector('[data-codigo="3"]').hidden, false);
});
test('rating can be submitted with stars only and no comment', async t => {
    const f = await fixture(t, (route, options) => {
        if (route.pathname === '/api/items/juguetes') return [{ id: 1, nombre: 'Producto', precio: 5, imagen: '/p.png' }];
        if (route.pathname.endsWith('/resenas')) return options.method === 'POST' ? { message: 'OK' } : [];
    });
    f.window.document.querySelector('[data-target="sec-mercancia"]').click(); await tick();
    f.window.document.querySelector('.rate-product-button').click(); await tick(); assert.equal(f.$('submit-review-btn').disabled, true);
    f.$('star4').checked = true; f.$('star4').dispatchEvent(new f.window.Event('change')); f.$('submit-review-btn').click(); await tick();
    const call = f.calls.find(([route, opts]) => route.endsWith('/resenas') && opts.method === 'POST');
    assert.deepEqual(JSON.parse(call[1].body), { estrellas: 4, comentario: '' });
});
