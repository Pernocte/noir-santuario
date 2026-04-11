const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');
const app = express();
const port = 3000;

app.use(cors());
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' })); 

// 1. CONEXIÓN A MYSQL (AIVEN CLOUD)
// CONEXIÓN A MYSQL (AIVEN CLOUD)
const db = mysql.createPool({
    host: 'noir-db-solomau3-ac8e.l.aivencloud.com', 
    user: 'avnadmin',                               
    password: 'AVNS_RrvZ6qbHIIHQjzzRY1m',    
    port: 11158,                                    
    database: 'defaultdb',                          
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false // ¡Clave para que Aiven te deje entrar!
    }
});

db.getConnection((err, connection) => {
    if (err) console.error('Error MySQL:', err);
    else { console.log('Santuario NOIR: Base de datos conectada.'); connection.release(); }
});

// --- USUARIOS Y PERFIL ---
app.post('/api/login', (req, res) => {
    const { codigo } = req.body;
    db.query('SELECT * FROM usuarios WHERE codigo = ?', [codigo], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error del servidor' });
        if (results.length > 0) res.json({ success: true, user: results[0] });
        else res.status(401).json({ success: false, message: 'Código inválido' });
    });
});

app.post('/api/usuarios', (req, res) => {
    const { codigo, nombre, sexo, foto, adminCode } = req.body;
    db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode], (err, check) => {
        if (err || check.length === 0 || check[0].rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
        db.query('INSERT INTO usuarios (codigo, nombre, rol, sexo, foto, saldo) VALUES (?, ?, "user", ?, ?, 0.00)', [codigo, nombre, sexo, foto], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Este PIN ya existe' });
                return res.status(500).json({ error: 'Error BD' });
            }
            res.json({ success: true });
        });
    });
});

app.post('/api/perfil/foto', (req, res) => {
    const { codigo, nuevaFoto } = req.body;
    db.query('UPDATE usuarios SET foto = ? WHERE codigo = ?', [nuevaFoto, codigo], (err) => {
        if (err) return res.status(500).json({ error: 'Error al actualizar' });
        res.json({ success: true });
    });
});

// --- GESTIÓN DE SALDO (NUEVO) ---
// Admin inyecta fondos
app.post('/api/admin/fondos', (req, res) => {
    const { adminCode, targetPin, monto } = req.body;
    db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode], (err, check) => {
        if (err || check.length === 0 || check[0].rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
        
        // Sumar el monto al saldo actual
        db.query('UPDATE usuarios SET saldo = saldo + ? WHERE codigo = ?', [parseFloat(monto), targetPin], (err, results) => {
            if (err) return res.status(500).json({ error: 'Error al transferir fondos' });
            if (results.affectedRows === 0) return res.status(404).json({ error: 'PIN de usuario no encontrado' });
            res.json({ success: true, message: `Se añadieron $${monto} al usuario.` });
        });
    });
});

// Usuario realiza una compra
app.post('/api/comprar', (req, res) => {
    const { codigoUsuario, itemId } = req.body;

    // 1. Obtener precio del item y saldo del usuario
    db.query('SELECT precio FROM items WHERE id = ?', [itemId], (err, itemRes) => {
        if (err || itemRes.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
        const precio = parseFloat(itemRes[0].precio);

        db.query('SELECT saldo FROM usuarios WHERE codigo = ?', [codigoUsuario], (err, userRes) => {
            if (err || userRes.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
            const saldoActual = parseFloat(userRes[0].saldo);

            // 2. Verificar fondos
            if (saldoActual < precio) {
                return res.status(400).json({ error: 'Fondos insuficientes. Contacte al Administrador.' });
            }

            // 3. Descontar saldo
            const nuevoSaldo = saldoActual - precio;
            db.query('UPDATE usuarios SET saldo = ? WHERE codigo = ?', [nuevoSaldo, codigoUsuario], (err) => {
                if (err) return res.status(500).json({ error: 'Error al procesar pago' });
                res.json({ success: true, message: 'Compra aprobada con éxito.', nuevoSaldo: nuevoSaldo });
            });
        });
    });
});

// --- EVENTO ---
app.get('/api/evento', (req, res) => {
    db.query('SELECT * FROM evento WHERE id = 1', (err, results) => {
        if (err) return res.status(500).json({ error: 'Error' });
        res.json(results[0]);
    });
});

app.put('/api/evento', (req, res) => {
    const { titulo, fecha, hora, descripcion, adminCode } = req.body;
    db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode], (err, check) => {
        if (err || check.length === 0 || check[0].rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
        db.query('UPDATE evento SET titulo=?, fecha=?, hora=?, descripcion=? WHERE id=1', [titulo, fecha, hora, descripcion], (err) => {
            if (err) return res.status(500).json({ error: 'Error al actualizar evento' });
            res.json({ success: true });
        });
    });
});

// --- ITEMS ---
app.get('/api/items/:categoria', (req, res) => {
    const query = `
        SELECT i.*, IFNULL(r_stats.promedio, 0) as promedio_estrellas, IFNULL(r_stats.total, 0) as total_resenas
        FROM items i
        LEFT JOIN ( SELECT item_id, AVG(estrellas) as promedio, COUNT(id) as total FROM resenas GROUP BY item_id ) r_stats ON i.id = r_stats.item_id
        WHERE i.categoria = ? ORDER BY i.fecha_agregado DESC
    `;
    db.query(query, [req.params.categoria], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error' }); res.json(results);
    });
});

app.post('/api/items', (req, res) => {
    const { categoria, nombre, imagen, precio, adminCode } = req.body;
    db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode], (err, check) => {
        if (err || check.length === 0 || check[0].rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
        db.query('INSERT INTO items (categoria, nombre, imagen, precio) VALUES (?, ?, ?, ?)', [categoria, nombre, imagen, parseFloat(precio)], (err) => {
            if (err) return res.status(500).json({ error: 'Error al crear item' });
            res.json({ success: true });
        });
    });
});

app.delete('/api/items/:id', (req, res) => {
    const { adminCode } = req.body;
    db.query('SELECT rol FROM usuarios WHERE codigo = ?', [adminCode], (err, check) => {
        if (err || check.length === 0 || check[0].rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
        db.query('DELETE FROM items WHERE id = ?', [req.params.id], (err) => {
            if (err) return res.status(500).json({ error: 'Error' });
            res.json({ success: true });
        });
    });
});

// --- RESEÑAS Y COMENTARIOS ---
app.get('/api/items/:id/resenas', (req, res) => {
    db.query('SELECT r.*, u.nombre, u.foto FROM resenas r JOIN usuarios u ON r.usuario_codigo = u.codigo WHERE r.item_id = ? ORDER BY r.fecha DESC', [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error' }); res.json(results);
    });
});

app.post('/api/items/:id/resenas', (req, res) => {
    const { usuario_codigo, estrellas, comentario } = req.body;
    db.query('SELECT id FROM resenas WHERE item_id = ? AND usuario_codigo = ?', [req.params.id, usuario_codigo], (err, check) => {
        if (err) return res.status(500).json({ error: 'Error servidor' });
        if (check.length > 0) return res.status(400).json({ error: 'Ya has valorado este artículo.' });
        db.query('INSERT INTO resenas (item_id, usuario_codigo, estrellas, comentario) VALUES (?, ?, ?, ?)', [req.params.id, usuario_codigo, estrellas, comentario], (err) => {
            if (err) return res.status(500).json({ error: 'Error al comentar' }); res.json({ success: true });
        });
    });
});

// --- CONTACTOS Y MENSAJES ---
app.post('/api/contactos', (req, res) => {
    const { miCodigo, aliasContacto } = req.body;
    db.query('SELECT codigo FROM usuarios WHERE nombre = ?', [aliasContacto], (err, users) => {
        if (err || users.length === 0) return res.status(404).json({ error: 'No se encontró el Alias' });
        if (miCodigo === users[0].codigo) return res.status(400).json({ error: 'No puedes agregarte a ti mismo' });
        db.query('INSERT IGNORE INTO contactos (usuario_codigo, contacto_codigo) VALUES (?, ?), (?, ?)', [miCodigo, users[0].codigo, users[0].codigo, miCodigo], (err) => {
            if (err) return res.status(500).json({ error: 'Error' }); res.json({ success: true, message: 'Conexión establecida' });
        });
    });
});
app.get('/api/contactos/:codigo', (req, res) => {
    db.query('SELECT u.codigo, u.nombre, u.sexo, u.foto FROM usuarios u INNER JOIN contactos c ON u.codigo = c.contacto_codigo WHERE c.usuario_codigo = ?', [req.params.codigo], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error' }); res.json(results);
    });
});
app.get('/api/mensajes/:u1/:u2', (req, res) => {
    db.query('SELECT * FROM mensajes WHERE (remitente_codigo=? AND destinatario_codigo=?) OR (remitente_codigo=? AND destinatario_codigo=?) ORDER BY fecha ASC', [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error' }); res.json(results);
    });
});
app.post('/api/mensajes', (req, res) => {
    db.query('INSERT INTO mensajes (remitente_codigo, destinatario_codigo, mensaje) VALUES (?, ?, ?)', [req.body.remitente, req.body.destinatario, req.body.mensaje], (err) => {
        if (err) return res.status(500).json({ error: 'Error' }); res.json({ success: true });
    });
});
// Servir archivos estáticos
app.use(express.static('public'));

// Si alguien entra a cualquier ruta, mostrar el index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.listen(port, () => console.log(`Servidor NOIR corriendo en http://localhost:${port}`));
