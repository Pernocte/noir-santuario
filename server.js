'use strict';
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const sharp = require('sharp');

const categories = new Set(['modelos', 'mercancia', 'juguetes', 'lenceria', 'miscelaneo']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max = 255) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
function money(value, positive = false) {
    if (value === null || value === '' || typeof value === 'boolean' || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(String(value))) throw fail(400, 'Importe inválido (máximo dos decimales).');
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount > 9999999 || (positive && amount <= 0)) throw fail(400, 'Importe inválido.');
    return amount.toFixed(2);
}
function imageData(value, optional = false) {
    if (optional && !value) return null;
    if (typeof value !== 'string' || value.length > 12 * 1024 * 1024 || !/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail(400, 'Imagen inválida. Usa JPG, PNG, WebP o GIF de hasta 9 MB.');
    return value;
}
function createPool() {
    if (!process.env.DB_PASSWORD) throw new Error('Configura DB_PASSWORD en las variables de entorno.');
    return mysql.createPool({
        host: process.env.DB_HOST || 'noir-db-solomau3-ac8e.l.aivencloud.com',
        port: Number(process.env.DB_PORT || 11158), user: process.env.DB_USER || 'avnadmin',
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'defaultdb',
        waitForConnections: true, connectionLimit: 10, queueLimit: 100, connectTimeout: 15000,
        ssl: { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_PATH ? { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH, 'utf8') } : {}) }
    });
}
async function transaction(db, work) {
    for (let attempt = 0; ; attempt++) {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const result = await work(connection);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            if (error.code !== 'ER_LOCK_DEADLOCK' || attempt >= 2) throw error;
        } finally { connection.release(); }
    }
}
async function linkUsers(connection, a, b) {
    if (a === b) throw fail(400, 'No puedes agregarte a ti mismo.');
    // Serialize creation using existing user rows; no destructive schema change required.
    await connection.query('SELECT id FROM usuarios WHERE codigo IN (?, ?) ORDER BY id FOR UPDATE', [a, b]);
    for (const pair of [[a, b], [b, a]]) {
        const [rows] = await connection.query('SELECT id FROM contactos WHERE usuario_codigo = ? AND contacto_codigo = ?', pair);
        if (!rows.length) await connection.query('INSERT INTO contactos (usuario_codigo, contacto_codigo) VALUES (?, ?)', pair);
    }
}
function createApp(db, options = {}) {
    const app = express();
    const secret = options.sessionSecret || process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
    const presence = new Map();
    const mediaCache = new Map();
    let mediaBytes = 0;
    const loginAttempts = new Map();
    const sign = value => crypto.createHmac('sha256', secret).update(value).digest('base64url');
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ limit: '50mb', extended: false }));
    app.use((req, res, next) => {
        req.body ??= {};
        if (typeof req.body !== 'object' || Array.isArray(req.body)) throw fail(400, 'Cuerpo de solicitud inválido.');
        next();
    });
    app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    app.post('/api/login', async (req, res) => {
        const now = Date.now();
        for (const [ip, attempt] of loginAttempts) if (attempt.until <= now) loginAttempts.delete(ip);
        const attempt = loginAttempts.get(req.ip) || { count: 0, until: now + 15 * 60000 };
        if (++attempt.count > 30) throw fail(429, 'Demasiados intentos. Espera 15 minutos.');
        loginAttempts.set(req.ip, attempt);
        if (!text(req.body.codigo, 20)) throw fail(400, 'Ingresa un código válido.');
        const [rows] = await db.query('SELECT id, nombre, rol, saldo FROM usuarios WHERE codigo = ?', [req.body.codigo]);
        if (!rows.length) throw fail(401, 'Código inválido o usuario no existe.');
        loginAttempts.delete(req.ip);
        const user = rows[0];
        const payload = Buffer.from(JSON.stringify({ id: user.id, exp: Date.now() + 12 * 3600000 })).toString('base64url');
        res.cookie('noir_session', `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3600000, path: '/' });
        res.json({ success: true, user: { ...user, codigo: String(user.id), foto: `/api/media/usuarios/${user.id}` } });
    });
    app.post('/api/logout', (req, res) => { res.clearCookie('noir_session', { path: '/' }); res.json({ success: true }); });
    app.use('/api', async (req, res, next) => {
        const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('noir_session='))?.slice(13);
        try {
            const [payload, signature] = decodeURIComponent(token || '').split('.');
            const expected = sign(payload || '');
            if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw Error();
            const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
            if (session.exp <= Date.now()) throw Error();
            req.sessionId = session.id;
        } catch { throw fail(401, 'Tu sesión terminó. Vuelve a ingresar.'); }
        const [users] = await db.query('SELECT id, codigo, nombre, rol FROM usuarios WHERE id = ?', [req.sessionId]);
        if (!users.length) throw fail(401, 'Usuario no disponible.');
        req.user = users[0];
        // Keep only a bounded recent presence window; no ultima_conexion column required.
        const now = Date.now();
        presence.set(String(req.user.id), now);
        for (const [id, time] of presence) if (now - time > 120000) presence.delete(id);
        next();
    });
    const admin = (req, res, next) => { if (req.user.rol !== 'admin') throw fail(403, 'No autorizado.'); next(); };
    const own = (req, res, next) => { if (String(req.params.codigo || req.params.user1) !== String(req.user.id)) throw fail(403, 'No autorizado.'); next(); };
    async function recipient(id, connection = db) {
        if (!/^\d+$/.test(String(id))) throw fail(400, 'Contacto inválido.');
        const [rows] = await connection.query('SELECT id, codigo FROM usuarios WHERE id = ?', [id]);
        if (!rows.length) throw fail(404, 'Contacto no encontrado.');
        return rows[0];
    }
    app.get('/api/media/:type/:id', async (req, res) => {
        const columns = { items: ['items', 'imagen'], usuarios: ['usuarios', 'foto'] };
        const spec = columns[req.params.type];
        if (!spec) throw fail(404, 'Imagen no encontrada.');
        const variant = ['thumb', 'avatar'].includes(req.query.size) ? req.query.size : 'full';
        const cacheKey = `${req.params.type}:${req.params.id}:${variant}`;
        const cached = mediaCache.get(cacheKey);
        if (cached && cached.until > Date.now()) return res.set('Cache-Control', 'private, max-age=60').type(cached.type).send(cached.buffer);
        const [rows] = await db.query(`SELECT ${spec[1]} AS image FROM ${spec[0]} WHERE id = ?`, [req.params.id]);
        const value = rows[0]?.image;
        const match = typeof value === 'string' && value.match(/^data:image\/(jpeg|png|webp|gif);base64,([\s\S]+)$/);
        if (!match) {
            if (typeof value === 'string' && /^https?:\/\//i.test(value)) return res.redirect(value);
            // A neutral avatar/image keeps missing legacy photos from breaking the layout.
            return res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#222"/><text x="100" y="115" fill="#c6ac71" text-anchor="middle" font-size="45">☽</text></svg>');
        }
        let buffer = Buffer.from(match[2], 'base64'), type = `image/${match[1]}`;
        if (variant !== 'full') {
            try {
                buffer = await sharp(buffer, { limitInputPixels: 40000000 }).rotate().resize(variant === 'avatar' ? 96 : 440, variant === 'avatar' ? 96 : 440, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
                type = 'image/webp';
            } catch { /* Legacy malformed/unsupported images keep the existing fallback behavior. */ }
        }
        const previous = mediaCache.get(cacheKey);
        if (previous) { mediaBytes -= previous.buffer.length; mediaCache.delete(cacheKey); }
        if (buffer.length < 4 * 1024 * 1024) {
            while (mediaCache.size && (mediaBytes + buffer.length > 24 * 1024 * 1024 || mediaCache.size >= 120)) {
                const key = mediaCache.keys().next().value; mediaBytes -= mediaCache.get(key).buffer.length; mediaCache.delete(key);
            }
            mediaCache.set(cacheKey, { buffer, type, until: Date.now() + 60000 }); mediaBytes += buffer.length;
        }
        res.set('Cache-Control', 'private, max-age=60').type(type).send(buffer);
    });
    app.get('/api/evento', async (req, res) => {
        const [rows] = await db.query('SELECT * FROM evento WHERE id = 1');
        res.json(rows[0] || { titulo: 'Sin evento', fecha: '', hora: '', descripcion: '' });
    });
    app.put('/api/evento', admin, async (req, res) => {
        const { titulo, fecha, hora, descripcion } = req.body;
        if (!text(titulo) || ![fecha, hora, descripcion].every(v => typeof v === 'string')) throw fail(400, 'Datos de evento inválidos.');
        await db.query('INSERT INTO evento (id, titulo, fecha, hora, descripcion) VALUES (1, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE titulo=?, fecha=?, hora=?, descripcion=?', [titulo, fecha, hora, descripcion, titulo, fecha, hora, descripcion]);
        res.json({ message: 'Evento actualizado.' });
    });
    app.get('/api/items/:categoria', async (req, res) => {
        if (!categories.has(req.params.categoria)) throw fail(400, 'Categoría inválida.');
        const [rows] = await db.query(`SELECT i.id, i.categoria, i.nombre, i.precio, COALESCE(r.total_resenas, 0) AS total_resenas, r.promedio_estrellas FROM items i LEFT JOIN (SELECT item_id, COUNT(*) AS total_resenas, AVG(estrellas) AS promedio_estrellas FROM resenas GROUP BY item_id) r ON r.item_id = i.id WHERE i.categoria = ? ORDER BY i.id DESC`, [req.params.categoria]);
        res.json(rows.map(item => ({ ...item, imagen: `/api/media/items/${item.id}`, miniatura: `/api/media/items/${item.id}?size=thumb` })));
    });
    app.post('/api/items', admin, async (req, res) => {
        const { categoria, nombre, imagen, precio = 0 } = req.body;
        if (!categories.has(categoria) || !text(nombre)) throw fail(400, 'Nombre o categoría inválidos.');
        await db.query('INSERT INTO items (categoria, nombre, imagen, precio) VALUES (?, ?, ?, ?)', [categoria, nombre.trim(), imageData(imagen), money(precio)]);
        res.json({ message: 'Item creado.' });
    });
    app.delete('/api/items/:id', admin, async (req, res) => {
        const [result] = await db.query('DELETE FROM items WHERE id = ?', [req.params.id]);
        if (!result.affectedRows) throw fail(404, 'Item no encontrado.');
        res.json({ message: 'Item eliminado.' });
    });
    app.post('/api/usuarios', admin, async (req, res) => {
        const { codigo, nombre, sexo, foto } = req.body;
        if (!text(codigo, 20) || !text(nombre)) throw fail(400, 'Nombre o código inválidos.');
        const [existing] = await db.query('SELECT id FROM usuarios WHERE codigo = ? OR nombre = ?', [codigo, nombre.trim()]);
        if (existing.length) throw fail(409, 'PIN o alias ya en uso.');
        await db.query('INSERT INTO usuarios (codigo, nombre, sexo, foto) VALUES (?, ?, ?, ?)', [codigo, nombre.trim(), sexo || 'No especificado', imageData(foto, true)]);
        res.json({ message: 'Usuario creado exitosamente.' });
    });
    async function purchase(req, model) {
        return transaction(db, async connection => {
            const [users] = await connection.query('SELECT saldo FROM usuarios WHERE id = ? FOR UPDATE', [req.user.id]);
            const [items] = await connection.query('SELECT precio, nombre, categoria FROM items WHERE id = ? FOR UPDATE', [model ? req.body.modeloId : req.body.itemId]);
            if (!users.length || !items.length) throw fail(404, 'Datos no encontrados.');
            const item = items[0];
            const price = money(item.precio);
            if (model && item.categoria !== 'modelos') throw fail(400, 'El item no es un modelo.');
            if (Number(users[0].saldo) < Number(price)) throw fail(400, 'Fondos insuficientes.');
            let message = `Compra exitosa: ${item.nombre}`;
            if (model) {
                const [models] = await connection.query('SELECT codigo FROM usuarios WHERE nombre = ?', [item.nombre]);
                if (models.length > 1) throw fail(409, 'Hay varios usuarios con ese alias. Administración debe corregirlo.');
                if (models.length) {
                    await linkUsers(connection, req.user.codigo, models[0].codigo);
                    message = `¡Acceso concedido! ${item.nombre} ha sido añadida a tu Red Privada.`;
                } else {
                    // Preserve the original manual-fulfilment behavior.
                    message = `Pago exitoso. La administración gestionará pronto tu conexión con ${item.nombre}.`;
                }
            }
            await connection.query('UPDATE usuarios SET saldo = saldo - ? WHERE id = ?', [price, req.user.id]);
            const [balances] = await connection.query('SELECT saldo FROM usuarios WHERE id = ?', [req.user.id]);
            return { message, nuevoSaldo: balances[0].saldo };
        });
    }
    app.post('/api/comprar', async (req, res) => res.json(await purchase(req, false)));
    app.post('/api/modelos/contactar', async (req, res) => res.json(await purchase(req, true)));
    app.post('/api/admin/fondos', admin, async (req, res) => {
        const { targetPin, monto } = req.body;
        if (!text(targetPin, 20)) throw fail(400, 'PIN inválido.');
        const amount = money(monto, true);
        const result = await transaction(db, async connection => {
            const [users] = await connection.query('SELECT id FROM usuarios WHERE codigo = ? FOR UPDATE', [targetPin]);
            if (!users.length) throw fail(404, 'No existe usuario.');
            await connection.query('UPDATE usuarios SET saldo = saldo + ? WHERE id = ?', [amount, users[0].id]);
            const [rows] = await connection.query('SELECT saldo FROM usuarios WHERE id = ?', [users[0].id]);
            return { nuevoSaldo: rows[0].saldo, esPropio: users[0].id === req.user.id };
        });
        res.json({ ...result, message: `Fondos inyectados. Nuevo saldo: $${Number(result.nuevoSaldo).toFixed(2)}` });
    });
    app.get('/api/items/:id/resenas', async (req, res) => {
        const [rows] = await db.query('SELECT r.id, r.estrellas, r.comentario, u.id AS usuario_id, u.nombre FROM resenas r JOIN usuarios u ON r.usuario_codigo = u.codigo WHERE r.item_id = ? ORDER BY r.id DESC', [req.params.id]);
        res.json(rows.map(row => ({ ...row, usuario_codigo: String(row.usuario_id), foto: `/api/media/usuarios/${row.usuario_id}` })));
    });
    app.post('/api/items/:id/resenas', async (req, res) => {
        const { estrellas, comentario = '' } = req.body;
        if (!Number.isInteger(estrellas) || estrellas < 1 || estrellas > 5 || typeof comentario !== 'string' || comentario.length > 5000) throw fail(400, 'Valoración inválida.');
        await transaction(db, async connection => {
            await connection.query('SELECT id FROM usuarios WHERE id = ? FOR UPDATE', [req.user.id]);
            const [rows] = await connection.query('SELECT id FROM resenas WHERE item_id = ? AND usuario_codigo = ?', [req.params.id, req.user.codigo]);
            if (rows.length) throw fail(409, 'Ya valoraste este elemento.');
            await connection.query('INSERT INTO resenas (item_id, usuario_codigo, estrellas, comentario) VALUES (?, ?, ?, ?)', [req.params.id, req.user.codigo, estrellas, comentario]);
        });
        res.json({ message: 'Reseña guardada.' });
    });
    app.get('/api/usuarios/buscar', async (req, res) => {
        const nick = String(req.query.nick || '').trim().replace(/^@/, '');
        if (!text(nick)) throw fail(400, 'Escribe el nick del usuario.');
        const [rows] = await db.query('SELECT id, nombre FROM usuarios WHERE nombre = ?', [nick]);
        if (!rows.length) throw fail(404, 'No encontramos ese nick. Revisa cómo está escrito.');
        if (rows.length > 1) throw fail(409, 'Ese nick está duplicado. Pide a administración que lo revise.');
        if (String(rows[0].id) === String(req.user.id)) throw fail(400, 'Ese es tu propio nick. Busca el de un amigo.');
        res.json({ codigo: String(rows[0].id), nombre: rows[0].nombre, foto: `/api/media/usuarios/${rows[0].id}?size=avatar` });
    });
    app.get('/api/contactos/:codigo', own, async (req, res) => {
        const [rows] = await db.query(`SELECT DISTINCT u.id, u.nombre, u.sexo,
            (SELECT COUNT(*) FROM mensajes unread WHERE unread.remitente_codigo = u.codigo AND unread.destinatario_codigo = ? AND unread.leido = 0) AS no_leidos,
            (SELECT IF(LEFT(m.mensaje, 10) = 'data:image', '📷 Foto', LEFT(m.mensaje, 100)) FROM mensajes m WHERE (m.remitente_codigo = u.codigo AND m.destinatario_codigo = ?) OR (m.remitente_codigo = ? AND m.destinatario_codigo = u.codigo) ORDER BY m.id DESC LIMIT 1) AS ultimo_mensaje,
            (SELECT MAX(m.fecha) FROM mensajes m WHERE (m.remitente_codigo = u.codigo AND m.destinatario_codigo = ?) OR (m.remitente_codigo = ? AND m.destinatario_codigo = u.codigo)) AS ultimo_fecha
            FROM contactos c JOIN usuarios u ON c.contacto_codigo = u.codigo WHERE c.usuario_codigo = ? ORDER BY ultimo_fecha DESC, u.nombre, u.id`, Array(6).fill(req.user.codigo));
        res.json(rows.map(row => ({ ...row, codigo: String(row.id), foto: `/api/media/usuarios/${row.id}?size=avatar`, ultima_conexion: presence.has(String(row.id)) ? new Date(presence.get(String(row.id))).toISOString() : null })));
    });
    app.post('/api/contactos', async (req, res) => {
        if (!text(req.body.aliasContacto)) throw fail(400, 'Ingresa un alias.');
        const [rows] = await db.query('SELECT codigo FROM usuarios WHERE nombre = ?', [req.body.aliasContacto.trim().replace(/^@/, '')]);
        if (!rows.length) throw fail(404, 'Alias no encontrado.');
        if (rows.length > 1) throw fail(409, 'Alias duplicado. Solicita su corrección a administración.');
        await transaction(db, connection => linkUsers(connection, req.user.codigo, rows[0].codigo));
        res.json({ message: 'Contacto añadido. La conexión es mutua.' });
    });
    const conversation = '(remitente_codigo = ? AND destinatario_codigo = ?) OR (remitente_codigo = ? AND destinatario_codigo = ?)';
    app.get('/api/mensajes/:user1/:user2', own, async (req, res) => {
        const other = await recipient(req.params.user2);
        const pair = [req.user.codigo, other.codigo, other.codigo, req.user.codigo];
        const after = Number(req.query.after || 0), before = Number(req.query.before || 0);
        if (![after, before].every(n => Number.isSafeInteger(n) && n >= 0)) throw fail(400, 'Cursor inválido.');
        const result = await transaction(db, async connection => {
            // A read receipt is emitted only while the conversation is visible.
            if (req.query.read === '1') await connection.query('UPDATE mensajes SET leido = 1 WHERE remitente_codigo = ? AND destinatario_codigo = ? AND leido = 0', [other.codigo, req.user.codigo]);
            const [state] = await connection.query(`SELECT id, leido FROM mensajes WHERE ${conversation} ORDER BY id`, pair);
            const condition = before ? ' AND id < ?' : (after ? ' AND id > ?' : '');
            const [rows] = await connection.query(`SELECT id, remitente_codigo, mensaje, fecha, leido FROM mensajes WHERE (${conversation})${condition} ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT 100`, condition ? [...pair, before || after] : pair);
            if (!after) rows.reverse();
            return { state, messages: rows.map(row => ({ ...row, remitente_codigo: String(row.remitente_codigo === req.user.codigo ? req.user.id : other.id) })), hasOlder: !!rows.length && state.some(s => s.id < rows[0].id) };
        });
        res.json(result);
    });
    app.post('/api/mensajes', async (req, res) => {
        const { destinatario, mensaje } = req.body;
        if (typeof mensaje !== 'string' || !mensaje.trim()) throw fail(400, 'Mensaje vacío.');
        if (mensaje.startsWith('data:')) imageData(mensaje);
        else if (mensaje.length > 10000) throw fail(400, 'Mensaje demasiado largo.');
        const other = await recipient(destinatario);
        const result = await transaction(db, async connection => {
            await linkUsers(connection, req.user.codigo, other.codigo);
            const [row] = await connection.query('INSERT INTO mensajes (remitente_codigo, destinatario_codigo, mensaje) VALUES (?, ?, ?)', [req.user.codigo, other.codigo, mensaje]);
            return row;
        });
        res.json({ success: true, id: result.insertId });
    });
    app.delete('/api/mensajes/:user1/:user2', own, async (req, res) => {
        const other = await recipient(req.params.user2);
        await db.query(`DELETE FROM mensajes WHERE ${conversation}`, [req.user.codigo, other.codigo, other.codigo, req.user.codigo]);
        res.json({ message: 'Historial eliminado exitosamente.' });
    });
    app.post('/api/perfil/foto', async (req, res) => {
        await db.query('UPDATE usuarios SET foto = ? WHERE id = ?', [imageData(req.body.nuevaFoto), req.user.id]);
        for (const [key, value] of mediaCache) if (key.startsWith(`usuarios:${req.user.id}:`)) { mediaBytes -= value.buffer.length; mediaCache.delete(key); }
        res.json({ success: true });
    });
    app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status = error.status || (error.code === 'ER_DUP_ENTRY' ? 409 : error.code === 'ER_NO_REFERENCED_ROW_2' ? 400 : 500);
        if (status >= 500) console.error('API error:', error.code || error.name);
        const message = status === 413 ? 'La imagen supera el tamaño permitido.' : status >= 500 ? 'No se pudo completar la operación. Intenta nuevamente.' : error.code === 'ER_DUP_ENTRY' ? 'El registro ya existe.' : error.code === 'ER_NO_REFERENCED_ROW_2' ? 'El usuario o producto ya no existe.' : error.message;
        res.status(status).json({ success: false, error: message, message });
    });
    return app;
}
if (require.main === module) {
    const db = createPool();
    const server = createApp(db).listen(process.env.PORT || 3000, () => console.log('Servidor NOIR iniciado.'));
    const stop = () => server.close(() => db.end().then(() => process.exit(0)));
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { createApp, transaction, money, imageData };
