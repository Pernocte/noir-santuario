'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, transaction, money, imageData } = require('../server');

async function fixture(t, handler = () => [[]], role = 'miembro') {
    const calls = [];
    const db = { query: async (sql, args) => {
        calls.push([sql, args]);
        if (sql === 'SELECT id, nombre, rol, saldo FROM usuarios WHERE codigo = ?') return [[{ id: 1, nombre: 'Test', rol: role, saldo: '100.00' }]];
        if (sql === 'SELECT id, codigo, nombre, rol FROM usuarios WHERE id = ?') return [[{ id: 1, codigo: 'private-pin', nombre: 'Test', rol: role }]];
        return handler(sql, args);
    }};
    db.getConnection = async () => ({ query: db.query, beginTransaction: async () => calls.push(['BEGIN']), commit: async () => calls.push(['COMMIT']), rollback: async () => calls.push(['ROLLBACK']), release() {} });
    const server = createApp(db, { sessionSecret: 'test-only' }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: 'private-pin' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const user = (await login.json()).user;
    return { calls, user, request: (route, method = 'GET', body, authenticated = true) => fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }) };
}
test('monetary validation prevents negative, nonfinite and excessive precision values', () => {
    for (const input of [-1, NaN, Infinity, '1.001', '', null, true]) assert.throws(() => money(input));
    assert.equal(money('0'), '0.00'); assert.equal(money('1.25'), '1.25'); assert.throws(() => money(0, true));
});
test('images reject scripts and invalid payloads', () => {
    assert.throws(() => imageData('data:image/svg+xml;base64,AAAA'));
    assert.throws(() => imageData('javascript:alert(1)'));
    assert.equal(imageData(null, true), null);
    assert.equal(imageData('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});
test('login does not expose the access PIN; private endpoints require sessions', async t => {
    const f = await fixture(t);
    assert.equal(f.user.codigo, '1'); assert.ok(!JSON.stringify(f.user).includes('private-pin'));
    assert.equal((await f.request('/api/contactos/1', 'GET', undefined, false)).status, 401);
    assert.equal((await f.request('/api/contactos/2')).status, 403);
    assert.equal((await f.request('/api/items', 'POST', { adminCode: 'private-pin' })).status, 403);
});
test('gallery metadata omits Base64 and optional fecha_agregado', async t => {
    const f = await fixture(t, sql => {
        if (sql.includes('FROM items i')) { assert.ok(!sql.includes('fecha_agregado')); assert.ok(!sql.includes('i.*')); return [[{ id: 7, nombre: "L'Art", precio: '20.00' }]]; }
        return [[]];
    });
    const res = await f.request('/api/items/juguetes'); assert.equal(res.status, 200);
    assert.equal((await res.json())[0].imagen, '/api/media/items/7');
});
test('contact listing hides PINs and avoids missing ultima_conexion column', async t => {
    const f = await fixture(t, sql => {
        if (sql.includes('FROM contactos c')) { assert.ok(!sql.includes('ultima_conexion')); return [[{ id: 2, nombre: 'Contact', sexo: 'Otro' }]]; }
        return [[]];
    });
    const data = await (await f.request('/api/contactos/1')).json(); assert.equal(data[0].codigo, '2');
});
test('incremental chat loads only new content and maps author to public id', async t => {
    const f = await fixture(t, (sql, args) => {
        if (sql === 'SELECT id, codigo FROM usuarios WHERE id = ?') return [[{ id: 2, codigo: 'other-private-pin' }]];
        if (sql.startsWith('SELECT id, leido')) return [[{ id: 9, leido: 1 }, { id: 10, leido: 0 }]];
        if (sql.startsWith('SELECT id, remitente_codigo')) { assert.match(sql, /AND id > \?/); assert.equal(args.at(-1), 9); return [[{ id: 10, remitente_codigo: 'other-private-pin', mensaje: 'Hola', leido: 0 }]]; }
        return [{ affectedRows: 1 }];
    });
    const data = await (await f.request('/api/mensajes/1/2?after=9&read=1')).json();
    assert.equal(data.messages[0].remitente_codigo, '2'); assert.equal(data.state.length, 2);
    assert.ok(f.calls.some(([sql]) => sql.startsWith('UPDATE mensajes SET leido')));
});
test('hidden chat requests do not mark messages read', async t => {
    const f = await fixture(t, sql => sql === 'SELECT id, codigo FROM usuarios WHERE id = ?' ? [[{ id: 2, codigo: 'other' }]] : [[]]);
    assert.equal((await f.request('/api/mensajes/1/2?after=0')).status, 200);
    assert.ok(!f.calls.some(([sql]) => sql.startsWith('UPDATE mensajes')));
});
test('message and mutual contacts roll back together on insertion failure', async t => {
    const f = await fixture(t, sql => {
        if (sql === 'SELECT id, codigo FROM usuarios WHERE id = ?') return [[{ id: 2, codigo: 'other' }]];
        if (sql.startsWith('INSERT INTO mensajes')) throw Object.assign(new Error('test failure'), { code: 'TEST_DB' });
        if (sql.startsWith('SELECT')) return [[]];
        return [{ insertId: 9 }];
    });
    assert.equal((await f.request('/api/mensajes', 'POST', { destinatario: '2', mensaje: 'Hola' })).status, 500);
    assert.ok(f.calls.some(([sql]) => sql === 'ROLLBACK')); assert.ok(!f.calls.some(([sql]) => sql === 'COMMIT'));
});
test('purchase locks balance before debit and returns database balance', async t => {
    const f = await fixture(t, sql => {
        if (sql.includes('SELECT saldo FROM usuarios')) return [[{ saldo: sql.includes('FOR UPDATE') ? '100.00' : '70.00' }]];
        if (sql.startsWith('SELECT precio')) return [[{ precio: '30.00', nombre: 'Item', categoria: 'juguetes' }]];
        return [{ affectedRows: 1 }];
    });
    const res = await f.request('/api/comprar', 'POST', { itemId: 7, codigoUsuario: 'spoofed' });
    assert.equal(res.status, 200); assert.equal((await res.json()).nuevoSaldo, '70.00');
    const update = f.calls.find(([sql]) => sql.startsWith('UPDATE usuarios SET saldo = saldo -'));
    assert.deepEqual(update[1], ['30.00', 1]); assert.ok(f.calls.some(([sql]) => sql.includes('FOR UPDATE')));
});
test('insufficient balance prevents debit', async t => {
    const f = await fixture(t, sql => sql.startsWith('SELECT saldo') ? [[{ saldo: '10.00' }]] : sql.startsWith('SELECT precio') ? [[{ precio: '30.00', nombre: 'Item' }]] : [[]]);
    assert.equal((await f.request('/api/comprar', 'POST', { itemId: 7 })).status, 400);
    assert.ok(!f.calls.some(([sql]) => sql.startsWith('UPDATE usuarios SET saldo')));
});
test('unknown API routes return JSON, not SPA HTML', async t => {
    const f = await fixture(t); const res = await f.request('/api/unknown'); assert.equal(res.status, 404); assert.ok((await res.json()).error);
});
test('transaction retries deadlock and releases both connections', async () => {
    let runs = 0, releases = 0;
    const db = { getConnection: async () => ({ beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => releases++ }) };
    const value = await transaction(db, async () => { if (++runs === 1) throw Object.assign(new Error(), { code: 'ER_LOCK_DEADLOCK' }); return 42; });
    assert.equal(value, 42); assert.equal(releases, 2);
});
