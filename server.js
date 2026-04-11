const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Configuración básica y límite aumentado para aceptar fotos pesadas (Base64)
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==========================================
// CONEXIÓN A MYSQL (AIVEN CLOUD)
// ==========================================
const db = mysql.createPool({
    host: 'noir-db-solomau3-ac8e.l.aivencloud.com', 
    user: 'avnadmin',                               
    password: 'PON_AQUÍ_LA_CONTRASEÑA_DE_AIVEN',    // <-- ¡NO OLVIDES CAMBIAR ESTO ANTES DE GUARDAR!
    port: 11158,                                    
    database: 'defaultdb',                          
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false
    }
});

// ==========================================
// RUTAS DE LA API (BACKEND)
// ==========================================

// 1. LOGIN
app.post('/api/login', async (req, res) => {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ success: false, message: "Ingresa un código." });
    try {
        const [rows] = await db.query('SELECT id, codigo, nombre, rol, foto, saldo FROM usuarios WHERE codigo = ?', [codigo]);
        if (rows.length > 0) {
            res.json({ success: true, user: rows[0] });
        } else {
            res.status(401).json({ success: false, message: "Código inválido o usuario no existe." });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Error del servidor." });
    }
});

// 2. CREAR NUEVO USUARIO (Liberado a 20 caracteres)
app.post('/api/usuarios', async (req, res) => {
    const { adminCode, codigo, nombre, sexo, foto } = req.body;
    
    if (!codigo || codigo.length > 20 || !nombre) {
        return res.status(400).json({ error: "Faltan datos o contraseña muy larga (máximo 20 caracteres)." });
    }

    try {
        const [admin] = await db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode]);
        if (admin.length === 0 || admin[0].rol !== 'admin') {
            return res.status(403).json({ error: "No autorizado." });
        }

        const [existe] = await db.query('SELECT id FROM usuarios WHERE codigo = ?', [codigo]);
        if (existe.length > 0) {
            return res.status(400).json({ error: "Esa contraseña o PIN ya está en uso por otro miembro." });
        }

        await db.query('INSERT INTO usuarios (codigo, nombre, sexo, foto) VALUES (?, ?, ?, ?)', 
            [codigo, nombre, sexo || 'No especificado', foto || null]
        );
        res.json({ message: "Usuario creado exitosamente" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error interno de la base de datos." });
    }
});

// 3. EVENTO
app.get('/api/evento', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM evento LIMIT 1');
        if (rows.length > 0) res.json(rows[0]);
        else res.json({ titulo: "Sin evento", fecha: "", hora: "", descripcion: "" });
    } catch (err) { res.status(500).json({ error: "Error de servidor" }); }
});

app.put('/api/evento', async (req, res) => {
    const { adminCode, titulo, fecha, hora, descripcion } = req.body;
    try {
        const [admin] = await db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode]);
        if (admin.length === 0 || admin[0].rol !== 'admin') return res.status(403).json({ error: "No autorizado" });
        
        await db.query('UPDATE evento SET titulo=?, fecha=?, hora=?, descripcion=? WHERE id=1', [titulo, fecha, hora, descripcion]);
        res.json({ message: "Evento actualizado" });
    } catch (err) { res.status(500).json({ error: "Error de servidor" }); }
});

// 4. ITEMS (Catálogos)
app.get('/api/items/:categoria', async (req, res) => {
    try {
        const query = `
            SELECT i.*, COUNT(r.id) as total_resenas, AVG(r.estrellas) as promedio_estrellas 
            FROM items i 
            LEFT JOIN resenas r ON i.id = r.item_id 
            WHERE i.categoria = ? 
            GROUP BY i.id 
            ORDER BY i.fecha_agregado DESC`;
        const [rows] = await db.query(query, [req.params.categoria]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: "Error de BD" }); }
});

app.post('/api/items', async (req, res) => {
    const { adminCode, categoria, nombre, imagen, precio } = req.body;
    try {
        const [admin] = await db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode]);
        if (admin.length === 0 || admin[0].rol !== 'admin') return res.status(403).json({ error: "No autorizado" });
        
        await db.query('INSERT INTO items (categoria, nombre, imagen, precio) VALUES (?, ?, ?, ?)', [categoria, nombre, imagen, precio || 0]);
        res.json({ message: "Item creado" });
    } catch (err) { res.status(500).json({ error: "Error de BD" }); }
});

app.delete('/api/items/:id', async (req, res) => {
    const { adminCode } = req.body;
    try {
        const [admin] = await db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode]);
        if (admin.length === 0 || admin[0].rol !== 'admin') return res.status(403).json({ error: "No autorizado" });
        
        await db.query('DELETE FROM items WHERE id = ?', [req.params.id]);
        res.json({ message: "Item eliminado" });
    } catch (err) { res.status(500).json({ error: "Error de BD" }); }
});

// 5. COMPRAR ITEM
app.post('/api/comprar', async (req, res) => {
    const { codigoUsuario, itemId } = req.body;
    try {
        const [userRows] = await db.query('SELECT saldo FROM usuarios WHERE codigo = ?', [codigoUsuario]);
        const [itemRows] = await db.query('SELECT precio, nombre FROM items WHERE id = ?', [itemId]);
        
        if(userRows.length === 0 || itemRows.length === 0) return res.status(404).json({ error: "Usuario o item no encontrado" });
        
        const saldoActual = parseFloat(userRows[0].saldo);
        const precioItem = parseFloat(itemRows[0].precio);
        
        if(saldoActual < precioItem) return res.status(400).json({ error: "Fondos insuficientes." });
        
        const nuevoSaldo = saldoActual - precioItem;
        await db.query('UPDATE usuarios SET saldo = ? WHERE codigo = ?', [nuevoSaldo, codigoUsuario]);
        
        res.json({ message: `Compra exitosa: ${itemRows[0].nombre}`, nuevoSaldo: nuevoSaldo });
    } catch (err) { res.status(500).json({ error: "Error procesando compra" }); }
});

// 6. RESEÑAS
app.get('/api/items/:id/resenas', async (req, res) => {
    try {
        const query = `
            SELECT r.*, u.nombre, u.foto 
            FROM resenas r 
            JOIN usuarios u ON r.usuario_codigo = u.codigo 
            WHERE r.item_id = ? ORDER BY r.fecha DESC`;
        const [rows] = await db.query(query, [req.params.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: "Error de BD" }); }
});

app.post('/api/items/:id/resenas', async (req, res) => {
    const { usuario_codigo, estrellas, comentario } = req.body;
    const item_id = req.params.id;
    try {
        const [existe] = await db.query('SELECT id FROM resenas WHERE item_id = ? AND usuario_codigo = ?', [item_id, usuario_codigo]);
        if(existe.length > 0) return res.status(400).json({ error: "Ya valoraste este elemento." });
        
        await db.query('INSERT INTO resenas (item_id, usuario_codigo, estrellas, comentario) VALUES (?, ?, ?, ?)', [item_id, usuario_codigo, estrellas, comentario]);
        res.json({ message: "Reseña guardada" });
    } catch (err) { res.status(500).json({ error: "Error de BD" }); }
});

// 7. TESORERÍA: INYECTAR FONDOS
app.post('/api/admin/fondos', async (req, res) => {
    const { adminCode, targetPin, monto } = req.body;
    if(!targetPin || !monto || targetPin.length > 20) return res.status(400).json({ error: "Datos inválidos." });
    try {
        const [admin] = await db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode]);
        if (admin.length === 0 || admin[0].rol !== 'admin') return res.status(403).json({ error: "No autorizado" });
        
        const [targetUser] = await db.query('SELECT saldo FROM usuarios WHERE codigo = ?', [targetPin]);
        if(targetUser.length === 0) return res.status(404).json({ error: "No existe un usuario con esa contraseña." });
        
        const nuevoSaldo = parseFloat(targetUser[0].saldo) + parseFloat(monto);
        await db.query('UPDATE usuarios SET saldo = ? WHERE codigo = ?', [nuevoSaldo, targetPin]);
        res.json({ message: `Fondos inyectados correctamente. Nuevo saldo: $${nuevoSaldo.toFixed(2)}` });
    } catch (err) { res.status(500).json({ error: "Error de BD" }); }
});

// 8. RED PRIVADA (CONTACTOS)
app.get('/api/contactos/:codigo', async (req, res) => {
    try {
        const query = `
            SELECT u.codigo, u.nombre, u.sexo, u.foto 
            FROM contactos c 
            JOIN usuarios u ON c.contacto_codigo = u.codigo 
            WHERE c.usuario_codigo = ?`;
        const [rows] = await db.query(query, [req.params.codigo]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: "Error de BD" }); }
});

app.post('/api/contactos', async (req, res) => {
    const { miCodigo, aliasContacto } = req.body;
    try {
        const [targetUser] = await db.query('SELECT codigo FROM usuarios WHERE nombre = ?', [aliasContacto]);
        if(targetUser.length === 0) return res.status(404).json({ error: "Alias no encontrado en la base de datos." });
        
        const codigoContacto = targetUser[0].codigo;
        if(miCodigo === codigoContacto) return res.status(400).json({ error: "No puedes agregarte a ti mismo." });
        
        const [existe] = await db.query('SELECT id FROM contactos WHERE usuario_codigo = ? AND contacto_codigo = ?', [miCodigo, codigoContacto]);
        if(existe.length > 0) return res.status(400).json({ error: "Este usuario ya está en tu red." });
        
        await db.query('INSERT INTO contactos (usuario_codigo, contacto_codigo) VALUES (?, ?)', [miCodigo, codigoContacto]);
        res.json({ message: "Contacto añadido a tu red privada." });
    } catch (err) { res.status(500).json({ error: "Error interno" }); }
});

// 9. MENSAJES
app.get('/api/mensajes/:user1/:user2', async (req, res) => {
    const { user1, user2 } = req.params;
    try {
        const query = `SELECT * FROM mensajes WHERE (remitente_codigo = ? AND destinatario_codigo = ?) OR (remitente_codigo = ? AND destinatario_codigo = ?) ORDER BY fecha ASC`;
        const [rows] = await db.query(query, [user1, user2, user2, user1]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: "Error de BD" }); }
});

app.post('/api/mensajes', async (req, res) => {
    const { remitente, destinatario, mensaje } = req.body;
    try {
        await db.query('INSERT INTO mensajes (remitente_codigo, destinatario_codigo, mensaje) VALUES (?, ?, ?)', [remitente, destinatario, mensaje]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Error enviando mensaje" }); }
});

// 10. ACTUALIZAR FOTO PERFIL
app.post('/api/perfil/foto', async (req, res) => {
    const { codigo, nuevaFoto } = req.body;
    try {
        await db.query('UPDATE usuarios SET foto = ? WHERE codigo = ?', [nuevaFoto, codigo]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Error actualizando foto" }); }
});

// ==========================================
// SERVIR ARCHIVOS ESTÁTICOS Y FRONTEND
// ==========================================
app.use(express.static('public'));

// SOLUCIÓN AL ERROR DE RENDER (EXPRESS 5.0)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// INICIAR SERVIDOR
app.listen(port, () => {
    console.log(`Servidor NOIR corriendo en el puerto ${port}`);
});
