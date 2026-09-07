'use strict';
// Read-only compatibility check. It never creates or modifies tables or data.
const mysql = require('mysql2/promise');
const fs = require('node:fs');
const required = {
    usuarios: ['id', 'codigo', 'nombre', 'sexo', 'foto', 'rol', 'saldo'],
    evento: ['id', 'titulo', 'fecha', 'hora', 'descripcion'],
    items: ['id', 'categoria', 'nombre', 'imagen', 'precio'],
    resenas: ['id', 'item_id', 'usuario_codigo', 'estrellas', 'comentario'],
    contactos: ['id', 'usuario_codigo', 'contacto_codigo'],
    mensajes: ['id', 'remitente_codigo', 'destinatario_codigo', 'mensaje', 'fecha', 'leido']
};
(async () => {
    if (!process.env.DB_PASSWORD) throw new Error('Configura DB_PASSWORD.');
    const connection = await mysql.createConnection({ host: process.env.DB_HOST || 'noir-db-solomau3-ac8e.l.aivencloud.com', port: Number(process.env.DB_PORT || 11158), user: process.env.DB_USER || 'avnadmin', password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'defaultdb', ssl: { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_PATH ? { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH) } : {}) } });
    try {
        const [columns] = await connection.query('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
        let problems = 0;
        for (const [table, names] of Object.entries(required)) for (const name of names) {
            const column = columns.find(row => row.TABLE_NAME === table && row.COLUMN_NAME === name);
            if (!column) { console.error(`Falta ${table}.${name}`); problems++; }
        }
        for (const [table, name] of [['usuarios', 'foto'], ['items', 'imagen'], ['mensajes', 'mensaje']]) {
            const column = columns.find(row => row.TABLE_NAME === table && row.COLUMN_NAME === name);
            if (column && Number(column.CHARACTER_MAXIMUM_LENGTH) < 12 * 1024 * 1024) { console.error(`${table}.${name}: capacidad insuficiente para imágenes; usar MEDIUMTEXT o LONGTEXT.`); problems++; }
        }
        const category = columns.find(row => row.TABLE_NAME === 'items' && row.COLUMN_NAME === 'categoria');
        if (category?.DATA_TYPE === 'enum') for (const value of ['modelos', 'juguetes', 'lenceria', 'miscelaneo', 'mercancia']) {
            if (!category.COLUMN_TYPE.includes(`'${value}'`)) { console.error(`items.categoria no admite ${value}`); problems++; }
        }
        const [tables] = await connection.query('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
        for (const row of tables) if (required[row.TABLE_NAME] && row.ENGINE !== 'InnoDB') { console.error(`${row.TABLE_NAME}: debe usar InnoDB para transacciones y bloqueos.`); problems++; }
        console.log(problems ? `${problems} incompatibilidades. No se modificó la base de datos.` : 'Esquema compatible. No se modificó la base de datos.');
        process.exitCode = problems ? 1 : 0;
    } finally { await connection.end(); }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
