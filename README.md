# NOIR — Santuario Privado

Versión revisada del ZIP recibido el 7 de septiembre de 2026. Conserva la SPA de HTML, CSS y JavaScript, Express/MySQL, la paleta oscura y dorada y sus módulos: evento, modelos, boutique, perfil, chat, reseñas, compras, creación de accesos y tesorería.

## Antes de subir esta versión

1. Cambia en Aiven la contraseña que estaba escrita en el `server.js` original. Esta versión la toma de `DB_PASSWORD`; no contiene esa clave.
2. En Render configura `DB_PASSWORD` y un `SESSION_SECRET` aleatorio y estable. Las demás variables se muestran en `.env.example`. No subas un `.env` real al repositorio.
3. Usa Node 22.12 o posterior. Comando de construcción: `npm ci`. Comando de inicio: `npm start`.
4. Si Aiven requiere su certificado CA, guarda el certificado como archivo secreto y establece `DB_SSL_CA_PATH` con su ruta. La conexión valida el certificado TLS; no desactives esa validación.
5. Con las variables configuradas, ejecuta `npm run check:db` para verificar la compatibilidad del esquema. Es un diagnóstico de solo lectura: no crea ni altera tablas. Resuelve cualquier incompatibilidad antes de publicar.
6. Sube juntos `server.js`, `package.json`, `package-lock.json` y toda la carpeta `public`. Recarga completamente las pestañas abiertas después del despliegue. El protocolo del chat y los identificadores públicos cambiaron; el frontend anterior no es compatible con esta API.

Generar el secreto de sesión:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Para ejecutar localmente, copia `.env.example` a `.env`, completa sus valores y utiliza:

```sh
npm ci
node --env-file=.env scripts/check-db.js
node --env-file=.env server.js
```

Abre http://localhost:3000. `npm start` utiliza variables ya configuradas en el entorno; no carga `.env` por sí solo.

## Correcciones realizadas

### Chat

- Un ciclo de actualización espera a que termine el anterior. Se eliminó la doble consulta de contactos del radar.
- Las respuestas de conversaciones anteriores se descartan al cambiar de contacto. Las solicitudes pendientes se cancelan al salir del chat o esconder la pestaña.
- Los envíos capturan el destinatario antes de comenzar, incluso cuando todavía se está procesando una imagen.
- Los mensajes aparecen como enviados después de la confirmación del servidor. Los errores se muestran; el texto del borrador se recupera si su campo sigue vacío en la misma conversación.
- Se bloquean envíos repetidos mientras hay uno pendiente. Un fallo de red no provoca un reenvío automático que pueda duplicar mensajes.
- Los ticks cambian sobre la burbuja existente. No se reconstruyen todas las imágenes al cambiar una marca de lectura.
- El chat carga los últimos 100 mensajes; «Cargar mensajes anteriores» permite recuperar el historial previo. El radar solicita el contenido nuevo y metadatos de lectura/eliminación, evitando repetir las imágenes del historial.
- Se preserva la posición del usuario al leer mensajes anteriores. La eliminación del historial se refleja también en el otro cliente durante su siguiente consulta.
- Volver a contactos en móvil deja de marcar como leída la conversación abandonada.
- Mensaje y contactos mutuos se guardan en una transacción. Un error revierte la operación completa.
- Se eliminó la etiqueta «Encriptado»: esta aplicación no implementa cifrado de extremo a extremo. HTTPS protege el transporte cuando Render lo sirve por HTTPS.

### Galerías e imágenes

- Una categoría con respuesta lenta ya no sobrescribe la seleccionada después.
- El catálogo devuelve información y rutas de imágenes, en lugar de incluir cada Base64 varias veces en HTML y manejadores de clic.
- Se usan imágenes con dimensiones estables, carga diferida y decodificación asíncrona; los catálogos se solicitan al abrir su sección.
- Las fotografías nuevas se validan y redimensionan hasta 1600 px. JPG se comprime como JPG; PNG/WebP conservan transparencia mediante WebP. GIF conserva su animación, con límite de 9 MB.
- Hay estados de carga, vacío, error y reintento. Una foto ausente tiene una imagen neutra de respaldo.
- Los nombres con apóstrofes y el texto que contiene HTML ya no rompen los botones ni se ejecutan como código.
- Las respuestas de reseñas de un producto anterior no reemplazan las del producto abierto.
- Se corrigió el ancho de modales en móvil y el comportamiento de desplazamiento de los paneles de chat.

### Servidor y mantenimiento

- El acceso crea una cookie de sesión HttpOnly y SameSite. La API identifica al usuario desde esa sesión y verifica los permisos administrativos en el servidor.
- Las respuestas usan IDs públicos, no PIN de acceso. Los PIN existentes siguen funcionando para ingresar; las relaciones existentes en MySQL no se transforman.
- Compras y recargas usan bloqueos y transacciones para evitar perder actualizaciones concurrentes del saldo. La aritmética se realiza en MySQL y se devuelve el saldo guardado.
- Se validan importes, estrellas, imágenes, alias y categorías; las respuestas de error son JSON.
- El evento se puede guardar aunque todavía no exista su fila ID 1.
- Las consultas ya no dependen de `usuarios.ultima_conexion`, `items.fecha_agregado` ni `resenas.fecha`. La presencia se mantiene en memoria con vencimiento.
- Los archivos estáticos se sirven desde una ruta absoluta. Una ruta API inexistente devuelve 404 JSON.
- CSS y JavaScript se separaron en `public/styles.css` y `public/app.js`. Se quitó CORS, que no es necesario al servir frontend y API desde el mismo origen, y se agregó `npm start`.
- El límite de solicitudes es 50 MB; las imágenes individuales admitidas por la API son menores para evitar cargas excesivas.

## Esquema y datos existentes

No se recibió un volcado SQL y no se accedió a Aiven. Esta entrega no modifica datos ni incluye migraciones ejecutadas.

`check:db` comprueba columnas requeridas, almacenamiento de imágenes, categorías ENUM y tablas InnoDB. En particular:

- `mensajes` debe tener `id`, `fecha` y `leido` con valores 0/1; normalmente `id` es autoincremental y `leido` tiene valor predeterminado 0.
- `usuarios.foto`, `items.imagen` y `mensajes.mensaje` necesitan capacidad para Base64; MEDIUMTEXT o LONGTEXT son apropiados para los límites de esta versión.
- `items.categoria` debe admitir `modelos`, `juguetes`, `lenceria`, `miscelaneo` y la categoría histórica `mercancia`.
- `usuarios.codigo` debe seguir siendo único; las relaciones y sus `ON DELETE CASCADE` se mantienen según el esquema original.
- `usuarios.saldo` e `items.precio` deben ser DECIMAL con dos decimales; `saldo` debe tener valor predeterminado 0. El rol de un nuevo usuario debe seguir teniendo el valor predeterminado `miembro`.
- Para historiales grandes, conviene disponer de índices en `mensajes(remitente_codigo, destinatario_codigo, id)`, `contactos(usuario_codigo, contacto_codigo)` y `resenas(item_id, usuario_codigo)`. El comprobador no crea esos índices ni verifica todas las restricciones y valores predeterminados.

Si el comprobador informa un error, ajusta únicamente la columna o restricción indicada sobre una copia de respaldo, revisando primero su definición actual. No recrees las tablas existentes.

## Validación realizada

```sh
npm test
npm run check
```

**21 pruebas aprobadas**: 12 de servidor HTTP con base de datos simulada y 9 de lógica de interfaz con jsdom. Cubren permisos, PIN oculto, importes, transacciones y reversión, carga incremental, categorías lentas, errores con reintento, mezcla de conversaciones, borradores, ticks, contenido HTML inerte, envíos simultáneos, imágenes en tránsito, navegación móvil e historial anterior. También se verificó la sintaxis de los archivos JavaScript principales.

Las pruebas no equivalen a una integración con MySQL real. No se comprobó la conexión TLS con Aiven ni se desplegó en Render. Tampoco se realizó una inspección visual con navegador real: su descarga no estuvo disponible en el entorno. La decodificación de imágenes en un dispositivo real y la presentación final requieren la comprobación posterior al despliegue.

Comprobación final sugerida con dos cuentas: ingresar, enviar texto/foto, cambiar rápidamente de conversación, verificar ticks, volver a contactos en móvil, abrir cada categoría, subir una foto, publicar una reseña, comprar, recargar saldo y comprobar el historial anterior y su eliminación con cuentas de prueba.

## Límites y comportamiento conservado

- El saldo sigue siendo virtual. No se añadió una pasarela de pagos ni un registro contable de pedidos.
- El contacto de modelos conserva la regla original de cobrar y avisar que administración gestionará la conexión si no existe una cuenta con ese nombre. No hay envío automático de notificaciones al administrador. Los alias duplicados se rechazan en esa operación para evitar conectar con la persona incorrecta.
- Las fotos y mensajes siguen almacenados en MySQL. Las imágenes antiguas se sirven tal como estaban; no se recomprimieron ni se repararon archivos corruptos existentes.
- La sesión dura 12 horas. Sin `SESSION_SECRET` estable se invalida al reiniciar. El indicador de presencia y el límite de intentos de ingreso viven en memoria; con varias instancias necesitarían un almacén compartido.
- El PIN sigue siendo el secreto de acceso del sistema existente. No se introdujo una migración a contraseñas con hash en esta revisión.
- El radar aún consulta cada tres segundos cuando la sección está visible; no se cambió a WebSockets. Los metadatos de lectura contienen IDs del historial completo, aunque el contenido se pagina.
