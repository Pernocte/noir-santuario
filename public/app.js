'use strict';
document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const enc = encodeURIComponent;
    let currentUser = null, activeItemModalId = null, itemCategoryRef = '', currentCategoryToAdd = '';
    let activeChatCode = null, chatGeneration = 0, messageRequest = null, contactsRequest = null;
    let sending = false, deleting = false, olderAvailable = false;
    const messages = new Map(), galleryRequests = new Map();
    let contactsSignature = '', reviewRequest = null;
    const photos = { item: null, user: null };
    const photoJobs = { item: null, user: null };
    const photoVersions = { item: 0, user: 0 };
    const report = error => { if (error.name !== 'AbortError') alert(error.message || 'No se pudo completar la operación.'); };
    async function api(route, { method = 'GET', body, signal } = {}) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(new Error('El servidor tardó demasiado. Comprueba la conexión antes de repetir la operación.')), 30000);
        try {
            const response = await fetch(`/api${route}`, { method, credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
                ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
            const data = await response.json().catch(() => { throw new Error('El servidor devolvió una respuesta inválida.'); });
            if (!response.ok) throw new Error(data.error || data.message || `Error ${response.status}`);
            return data;
        } finally { clearTimeout(timer); }
    }
    function bind(id, handler, event = 'click') {
        const element = $(id);
        element.addEventListener(event, async e => {
            if (element.dataset.busy) return;
            element.dataset.busy = '1';
            const button = element.tagName === 'BUTTON';
            if (button) element.disabled = true;
            try { await handler(e); } catch (error) { report(error); }
            finally { delete element.dataset.busy; if (button) element.disabled = false; }
        });
    }
    function element(tag, className, value) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined) node.textContent = value;
        return node;
    }
    function background(node, url) { node.style.backgroundImage = url ? `url(${JSON.stringify(url)})` : 'none'; }
    function image(url, className, name = 'Fotografía') {
        const img = element('img', className);
        img.alt = name; img.loading = 'lazy'; img.decoding = 'async'; img.src = url || '';
        img.addEventListener('error', () => { img.alt = 'No se pudo cargar la foto'; img.classList.add('image-error'); });
        return img;
    }
    function actualizarSaldoUI(value) { currentUser.saldo = value; $('my-profile-balance').textContent = `FONDOS: $${Number(value).toFixed(2)}`; }
    async function compressImage(file) {
        if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error('Selecciona una imagen JPG, PNG, WebP o GIF.');
        if (file.size > 20 * 1024 * 1024) throw new Error('La foto supera 20 MB. Selecciona una más pequeña.');
        // Preserve animation for GIF uploads instead of flattening the first frame.
        if (file.type === 'image/gif') {
            if (file.size > 9 * 1024 * 1024) throw new Error('El GIF supera 9 MB. Selecciona uno más pequeño.');
            return new Promise((resolve, reject) => {
                const reader = new FileReader(); reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('No se pudo leer el GIF.')); reader.readAsDataURL(file);
            });
        }
        const url = URL.createObjectURL(file);
        try {
            const img = new Image();
            await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('No se pudo leer la imagen.')); img.src = url; });
            if (!img.naturalWidth || !img.naturalHeight) throw new Error('La imagen no tiene dimensiones válidas.');
            const ratio = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', .85);
        } finally { URL.revokeObjectURL(url); }
    }
    function photoInput(id, key, labelId) {
        $(id).addEventListener('change', () => {
            const version = ++photoVersions[key], file = $(id).files[0];
            photos[key] = null;
            if (!file) { $(labelId).textContent = '+ Seleccionar imagen'; return; }
            $(labelId).textContent = 'Procesando foto...';
            photoJobs[key] = compressImage(file).then(data => {
                if (version === photoVersions[key]) { photos[key] = data; $(labelId).textContent = '✓ Foto lista'; }
            }).catch(error => { if (version === photoVersions[key]) { $(labelId).textContent = '+ Seleccionar otra imagen'; report(error); } });
        });
    }
    photoInput('adm-item-foto', 'item', 'lbl-item-foto');
    photoInput('new-user-photo', 'user', 'upload-label');
    bind('verify-btn', async () => {
        if (!$('access-code').value) return;
        try {
            const data = await api('/login', { method: 'POST', body: { codigo: $('access-code').value } });
            currentUser = data.user; $('access-code').value = ''; $('code-error').style.display = 'none';
            $('my-profile-name').textContent = currentUser.nombre; $('my-profile-role').textContent = currentUser.rol === 'admin' ? 'Maestro' : 'Miembro';
            background($('my-profile-pic'), currentUser.foto); actualizarSaldoUI(currentUser.saldo);
            document.querySelectorAll('.admin-only-block').forEach(node => node.style.display = currentUser.rol === 'admin' ? 'block' : 'none');
            $('login-view').style.display = 'none'; $('dashboard-view').style.display = 'flex'; $('dashboard-view').style.opacity = '1';
            switchTab('sec-evento');
            await cargarEvento();
        } catch (error) { $('code-error').textContent = error.message; $('code-error').style.display = 'block'; }
    });
    $('access-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('verify-btn').click(); });
    bind('logout-btn', async () => { await api('/logout', { method: 'POST' }); location.reload(); });
    function chatVisible() { return currentUser && activeChatCode && !document.hidden && $('sec-perfil').classList.contains('active') && (innerWidth > 768 || $('mobile-chat-main').classList.contains('active-mobile')); }
    function invalidateChat() { chatGeneration++; messageRequest?.abort(); messageRequest = null; }
    function switchTab(id) {
        document.querySelectorAll('.nav-menu .nav-btn[data-target]').forEach(node => node.classList.toggle('active', node.dataset.target === id));
        document.querySelectorAll('.section-content').forEach(node => node.classList.toggle('active', node.id === id));
        if (id !== 'sec-perfil') invalidateChat();
        if (id === 'sec-perfil') { cargarContactos().catch(report); if (chatVisible()) cargarMensajes(); }
        if (id === 'sec-modelos') cargarItems('modelos');
        if (id === 'sec-mercancia') cambiarSubCategoria(document.querySelector('.sub-nav-btn.active')?.dataset.subcat || 'juguetes');
    }
    document.querySelectorAll('.nav-menu .nav-btn[data-target]').forEach(node => node.addEventListener('click', () => switchTab(node.dataset.target)));
    async function cargarEvento() {
        const event = await api('/evento');
        for (const key of ['titulo', 'fecha', 'hora', 'desc']) {
            const value = event[key === 'desc' ? 'descripcion' : key] || '';
            $(`ev-${key}`).textContent = value; $(`adm-ev-${key}`).value = value;
        }
    }
    bind('btn-edit-event', () => { $('event-display-mode').style.display = 'none'; $('event-edit-mode').style.display = 'block'; });
    bind('cancel-event-btn', () => { $('event-edit-mode').style.display = 'none'; $('event-display-mode').style.display = 'block'; });
    bind('update-event-btn', async () => {
        await api('/evento', { method: 'PUT', body: { titulo: $('adm-ev-titulo').value, fecha: $('adm-ev-fecha').value, hora: $('adm-ev-hora').value, descripcion: $('adm-ev-desc').value } });
        $('cancel-event-btn').click(); await cargarEvento();
    });
    window.cambiarSubCategoria = function(categoria) {
        document.querySelectorAll('.sub-nav-btn').forEach(node => node.classList.toggle('active', node.dataset.subcat === categoria));
        $('btn-add-boutique').onclick = () => abrirModalAgregar(categoria);
        $('btn-add-boutique').textContent = `+ AÑADIR A ${categoria.toUpperCase()}`;
        cargarItems(categoria);
    };
    async function cargarItems(category) {
        const grid = $(category === 'modelos' ? 'grid-modelos' : 'grid-mercancia-dinamico');
        // Never let a refresh from a modal replace a different selected category.
        if (category !== 'modelos' && document.querySelector('.sub-nav-btn.active')?.dataset.subcat !== category) return;
        galleryRequests.get(grid.id)?.abort();
        const controller = new AbortController(); galleryRequests.set(grid.id, controller);
        grid.replaceChildren(element('p', 'load-status', 'Cargando...'));
        try {
            const items = await api(`/items/${enc(category)}`, { signal: controller.signal });
            if (galleryRequests.get(grid.id) !== controller) return;
            if (!Array.isArray(items)) throw new Error('Catálogo inválido.');
            const fragment = document.createDocumentFragment();
            for (const item of items) {
                const card = element('div', 'grid-item');
                const img = image(item.imagen, 'grid-item-img', item.nombre);
                card.append(img, element('h3', 'catalog-name', item.nombre));
                if (currentUser.rol === 'admin') {
                    const del = element('button', 'del-btn', 'X'); del.style.display = 'block';
                    del.addEventListener('click', async e => {
                        e.stopPropagation(); if (del.disabled || !confirm('¿Eliminar permanentemente?')) return;
                        del.disabled = true;
                        try { await api(`/items/${item.id}`, { method: 'DELETE' }); await cargarItems(category); } catch (error) { report(error); del.disabled = false; }
                    }); card.append(del);
                }
                if (category === 'modelos') {
                    const actions = element('div', 'model-actions');
                    const view = element('button', 'gold-button', 'VER FOTO');
                    view.onclick = () => verFotoCompleta(item.imagen); img.onclick = view.onclick;
                    const contact = element('button', 'gold-button contact-model', `CONTACTAR ($${Number(item.precio).toFixed(2)})`);
                    contact.addEventListener('click', async () => {
                        if (contact.disabled || !confirm(`¿Desbloquear el contacto con ${item.nombre} por $${item.precio}?`)) return;
                        contact.disabled = true;
                        try { const data = await api('/modelos/contactar', { method: 'POST', body: { modeloId: item.id } }); actualizarSaldoUI(data.nuevoSaldo); alert(data.message); await cargarContactos(); }
                        catch (error) { report(error); } finally { contact.disabled = false; }
                    });
                    actions.append(view, contact); card.append(actions);
                } else {
                    if (Number(item.precio) > 0) card.append(element('p', 'item-price', `$${Number(item.precio).toFixed(2)}`));
                    card.append(element('p', 'item-stars-avg', Number(item.total_resenas) ? `★ ${Number(item.promedio_estrellas).toFixed(1)} (${item.total_resenas})` : 'Sin valoraciones'));
                    card.addEventListener('click', () => abrirModalItem(item, category));
                }
                fragment.append(card);
            }
            grid.replaceChildren(items.length ? fragment : element('p', 'load-status', 'No hay elementos en esta categoría.'));
        } catch (error) {
            if (controller.signal.aborted) return;
            const retry = element('button', 'gold-button', 'Reintentar'); retry.onclick = () => cargarItems(category);
            grid.replaceChildren(element('p', 'load-status', error.message), retry);
        }
    }
    window.verFotoCompleta = function(url) { $('full-photo-img').src = url; $('full-photo-img').alt = 'Fotografía ampliada'; $('photo-modal').style.display = 'flex'; };
    $('full-photo-img').onerror = () => { $('full-photo-img').alt = 'No se pudo cargar la imagen. Cierra y vuelve a intentarlo.'; };
    window.abrirModalAgregar = function(category) { currentCategoryToAdd = category; $('add-item-cat-label').textContent = category; $('add-item-modal').style.display = 'flex'; };
    bind('close-add-modal', () => $('add-item-modal').style.display = 'none');
    bind('confirm-add-item-btn', async () => {
        const category = currentCategoryToAdd;
        await photoJobs.item;
        if (!$('adm-item-nombre').value.trim() || !photos.item) throw new Error('Falta nombre e imagen.');
        await api('/items', { method: 'POST', body: { categoria: category, nombre: $('adm-item-nombre').value, precio: $('adm-item-precio').value || 0, imagen: photos.item } });
        $('adm-item-nombre').value = ''; $('adm-item-precio').value = ''; $('adm-item-foto').value = ''; photos.item = null;
        $('lbl-item-foto').textContent = '+ Subir Fotografía'; $('add-item-modal').style.display = 'none'; await cargarItems(category);
    });
    bind('close-modal', () => { activeItemModalId = null; reviewRequest?.abort(); $('item-modal').style.display = 'none'; });
    function abrirModalItem(item, category) {
        activeItemModalId = item.id; itemCategoryRef = category;
        $('modal-title').textContent = item.nombre; background($('modal-img'), item.imagen);
        $('modal-price').textContent = `$${Number(item.precio).toFixed(2)}`;
        $('modal-price').style.display = $('buy-item-btn').style.display = Number(item.precio) > 0 ? 'block' : 'none';
        $('my-comment-text').value = ''; document.querySelectorAll('input[name="rating"]').forEach(node => node.checked = false);
        $('item-modal').style.display = 'flex'; cargarResenas(item.id);
    }
    async function cargarResenas(id) {
        reviewRequest?.abort(); const controller = new AbortController(); reviewRequest = controller;
        $('modal-comments').textContent = 'Cargando valoraciones...'; $('review-form-container').style.display = 'none'; $('already-reviewed-msg').style.display = 'none';
        try {
            const reviews = await api(`/items/${id}/resenas`, { signal: controller.signal });
            if (activeItemModalId !== id || controller.signal.aborted) return;
            const fragment = document.createDocumentFragment();
            for (const review of reviews) {
                const row = element('div', 'comment-item'), avatar = element('div', 'comment-avatar'); background(avatar, review.foto);
                const content = element('div', 'comment-text-area'), author = element('span', 'comment-author', review.nombre);
                const add = element('button', 'add-contact-link', '✛ Agregar');
                add.onclick = () => addContact(review.nombre).catch(report); author.append(add);
                const stars = Math.max(0, Math.min(5, Number(review.estrellas) || 0));
                content.append(author, element('div', 'comment-stars', '★'.repeat(stars) + '☆'.repeat(5 - stars)), element('div', 'comment-body', review.comentario));
                row.append(avatar, content); fragment.append(row);
            }
            $('modal-comments').replaceChildren(reviews.length ? fragment : element('p', 'load-status', 'Sin valoraciones aún.'));
            const reviewed = reviews.some(review => review.usuario_codigo === currentUser.codigo);
            $('review-form-container').style.display = reviewed ? 'none' : 'block'; $('already-reviewed-msg').style.display = reviewed ? 'block' : 'none';
        } catch (error) { if (!controller.signal.aborted) { const retry = element('button', 'gold-button', 'Reintentar'); retry.onclick = () => cargarResenas(id); $('modal-comments').replaceChildren(element('p', '', error.message), retry); } }
    }
    bind('buy-item-btn', async () => {
        const id = activeItemModalId;
        if (!id || !confirm('¿Adquirir producto? Se descontará de tus fondos.')) return;
        const data = await api('/comprar', { method: 'POST', body: { itemId: id } }); actualizarSaldoUI(data.nuevoSaldo); alert(data.message);
        if (activeItemModalId === id) $('close-modal').click();
    });
    bind('submit-review-btn', async () => {
        const id = activeItemModalId, category = itemCategoryRef, rating = document.querySelector('input[name="rating"]:checked');
        if (!rating) throw new Error('Selecciona una calificación.');
        await api(`/items/${id}/resenas`, { method: 'POST', body: { estrellas: Number(rating.value), comentario: $('my-comment-text').value } });
        if (activeItemModalId === id) await cargarResenas(id); await cargarItems(category);
    });
    bind('add-fondos-btn', async () => {
        const data = await api('/admin/fondos', { method: 'POST', body: { targetPin: $('adm-fondos-pin').value, monto: $('adm-fondos-monto').value } });
        alert(data.message); $('adm-fondos-pin').value = ''; $('adm-fondos-monto').value = ''; if (data.esPropio) actualizarSaldoUI(data.nuevoSaldo);
    });
    bind('create-user-btn', async () => {
        await photoJobs.user;
        if ($('new-user-photo').files.length && !photos.user) throw new Error('Selecciona una foto válida o quita la selección.');
        await api('/usuarios', { method: 'POST', body: { codigo: $('new-user-code').value, nombre: $('new-user-name').value, sexo: $('new-user-sex').value, foto: photos.user } });
        alert('Acceso creado exitosamente.'); $('new-user-name').value = ''; $('new-user-code').value = ''; $('new-user-photo').value = ''; photos.user = null; $('upload-label').textContent = '+ Seleccionar Imagen (Opcional)';
    });
    bind('update-photo-input', async e => {
        const file = e.target.files[0]; if (!file) return;
        try { const data = await compressImage(file); await api('/perfil/foto', { method: 'POST', body: { nuevaFoto: data } }); currentUser.foto = data; background($('my-profile-pic'), data); }
        finally { e.target.value = ''; }
    }, 'change');
    async function addContact(alias) {
        if (!alias?.trim()) return;
        const data = await api('/contactos', { method: 'POST', body: { aliasContacto: alias.trim() } }); alert(data.message); await cargarContactos();
    }
    bind('add-contact-btn', () => addContact(prompt('Ingresa el ALIAS del usuario a conectar:')));
    function updateHeader(contact) {
        $('active-chat-name').textContent = contact.nombre; background($('active-chat-avatar'), contact.foto); $('active-chat-avatar').style.display = 'block';
        $('active-chat-status').style.display = 'block';
        $('active-chat-status').textContent = contact.online ? 'Red privada • En línea' : 'Red privada • Desconectado';
        $('active-chat-status').style.color = contact.online ? '#27c93f' : '#888';
    }
    async function cargarContactos() {
        if (!currentUser) return;
        if (contactsRequest) return contactsRequest;
        contactsRequest = (async () => {
            const contacts = await api(`/contactos/${enc(currentUser.codigo)}`);
            const normalized = contacts.map(contact => ({ ...contact, online: !!contact.ultima_conexion && Date.now() - Date.parse(contact.ultima_conexion) < 120000 }));
            const signature = JSON.stringify(normalized.map(({ ultima_conexion, ...contact }) => contact));
            const active = normalized.find(c => c.codigo === activeChatCode); if (active) updateHeader(active);
            if (signature === contactsSignature) return;
            contactsSignature = signature;
            const fragment = document.createDocumentFragment();
            for (const contact of normalized) {
                const row = element('div', 'contact-item'); row.dataset.codigo = contact.codigo; row.classList.toggle('active', contact.codigo === activeChatCode);
                const avatar = element('div', 'contact-avatar'); background(avatar, contact.foto);
                if (contact.online) avatar.append(element('span', 'online-dot'));
                row.append(avatar, element('div', 'contact-name', contact.nombre));
                row.addEventListener('click', () => openChat(contact)); fragment.append(row);
            }
            $('contact-list-container').replaceChildren(normalized.length ? fragment : element('p', 'load-status', 'Agrega un contacto para comenzar.'));
        })();
        try { await contactsRequest; } finally { contactsRequest = null; }
    }
    function setChatControls() {
        const disabled = !activeChatCode || sending || deleting;
        $('send-msg-btn').disabled = disabled; $('chat-img-btn').disabled = disabled; $('delete-chat-btn').disabled = disabled;
        $('chat-input').disabled = !activeChatCode || deleting;
    }
    function openChat(contact) {
        invalidateChat(); activeChatCode = contact.codigo; messages.clear(); olderAvailable = false;
        $('chat-input').value = ''; $('chat-box').replaceChildren(element('p', 'load-status', 'Cargando mensajes...'));
        document.querySelectorAll('.contact-item').forEach(row => row.classList.toggle('active', row.dataset.codigo === contact.codigo));
        updateHeader(contact); $('delete-chat-btn').style.display = 'block';
        $('mobile-sidebar').classList.add('hidden-mobile'); $('mobile-chat-main').classList.add('active-mobile'); setChatControls(); cargarMensajes(true);
    }
    bind('back-to-contacts-btn', () => {
        invalidateChat(); activeChatCode = null; messages.clear(); setChatControls();
        $('mobile-chat-main').classList.remove('active-mobile'); $('mobile-sidebar').classList.remove('hidden-mobile');
        $('delete-chat-btn').style.display = 'none'; $('chat-box').replaceChildren(element('p', 'load-status', 'Selecciona un contacto para chatear.'));
    });
    const chatNotice = element('div', 'chat-notice'); chatNotice.setAttribute('role', 'status'); $('chat-box').before(chatNotice);
    const olderButton = element('button', 'load-older', 'Cargar mensajes anteriores'); olderButton.hidden = true; $('chat-box').before(olderButton);
    olderButton.onclick = () => cargarMensajes(false, true);
    function makeBubble(message) {
        const mine = message.remitente_codigo === currentUser.codigo;
        const bubble = element('div', `msg-bubble ${mine ? 'msg-sent' : 'msg-received'}`); bubble.dataset.id = message.id;
        if (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(message.mensaje)) {
            const img = image(message.mensaje, 'msg-image', 'Imagen de chat'); img.loading = 'eager';
            img.onclick = () => verFotoCompleta(message.mensaje);
            img.onload = () => { const box = $('chat-box'); if (bubble.dataset.keepBottom === '1') box.scrollTop = box.scrollHeight; };
            bubble.append(img);
        } else bubble.append(element('span', 'message-text', message.mensaje));
        if (mine) bubble.append(element('span', 'message-tick'));
        return bubble;
    }
    function renderMessages(force, previousHeight = null) {
        const box = $('chat-box'), atBottom = force || box.scrollHeight - box.scrollTop <= box.clientHeight + 100;
        box.querySelectorAll('.load-status').forEach(node => node.remove());
        for (const node of [...box.children]) if (!messages.has(Number(node.dataset.id))) node.remove();
        const existing = new Map([...box.children].map(node => [Number(node.dataset.id), node]));
        const sorted = [...messages.values()].sort((a, b) => a.id - b.id);
        let cursor = box.firstChild;
        for (const message of sorted) {
            let bubble = existing.get(message.id);
            if (!bubble) bubble = makeBubble(message);
            if (bubble !== cursor) box.insertBefore(bubble, cursor); else cursor = cursor.nextSibling;
            bubble.dataset.keepBottom = atBottom && previousHeight === null ? '1' : '0';
            const tick = bubble.querySelector('.message-tick');
            if (tick) { const read = Number(message.leido) === 1; tick.textContent = read ? '✓✓' : '✓'; tick.style.color = read ? '#c6ac71' : '#555'; }
        }
        if (!sorted.length) box.append(element('p', 'load-status', 'Di “Hola”. El historial está vacío.'));
        if (previousHeight !== null) box.scrollTop += box.scrollHeight - previousHeight;
        else if (atBottom) box.scrollTop = box.scrollHeight;
        olderButton.hidden = !olderAvailable;
    }
    $('chat-box').addEventListener('scroll', () => { if ($('chat-box').scrollHeight - $('chat-box').scrollTop > $('chat-box').clientHeight + 100) $('chat-box').querySelectorAll('[data-keep-bottom]').forEach(node => node.dataset.keepBottom = '0'); });
    async function cargarMensajes(force = false, older = false) {
        if (!chatVisible() || deleting) return;
        if (messageRequest) { if (!force) return; messageRequest.abort(); }
        const controller = new AbortController(); messageRequest = controller;
        const generation = chatGeneration, recipient = activeChatCode;
        const ids = [...messages.keys()];
        const cursor = older && ids.length ? `before=${Math.min(...ids)}` : `after=${ids.length ? Math.max(...ids) : 0}`;
        olderButton.disabled = true;
        try {
            const data = await api(`/mensajes/${enc(currentUser.codigo)}/${enc(recipient)}?${cursor}&read=1`, { signal: controller.signal });
            if (generation !== chatGeneration || controller.signal.aborted || !chatVisible()) return;
            const oldHeight = older ? $('chat-box').scrollHeight : null;
            const state = new Map(data.state.map(row => [row.id, row.leido]));
            for (const id of messages.keys()) if (!state.has(id)) messages.delete(id);
            for (const message of data.messages) messages.set(message.id, message);
            for (const [id, message] of messages) if (state.has(id)) message.leido = state.get(id);
            olderAvailable = !!messages.size && data.state.some(row => row.id < Math.min(...messages.keys()));
            chatNotice.textContent = ''; renderMessages(force, oldHeight);
        } catch (error) { if (!controller.signal.aborted && generation === chatGeneration) chatNotice.textContent = `${error.message} Se reintentará automáticamente.`; }
        finally { if (messageRequest === controller) { messageRequest = null; olderButton.disabled = false; } }
    }
    async function sendMessage(content, recipient) {
        await api('/mensajes', { method: 'POST', body: { destinatario: recipient, mensaje: content } });
        if (activeChatCode === recipient) await cargarMensajes(true);
    }
    async function enviarMensaje() {
        const input = $('chat-input'), value = input.value, recipient = activeChatCode;
        if (sending || deleting || !recipient || !value.trim()) return;
        sending = true; setChatControls(); input.value = '';
        try { await sendMessage(value, recipient); }
        catch (error) { if (activeChatCode === recipient && !input.value) input.value = value; report(error); }
        finally { sending = false; setChatControls(); }
    }
    $('send-msg-btn').addEventListener('click', enviarMensaje);
    $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); enviarMensaje(); } });
    $('chat-img-btn').onclick = () => { if (activeChatCode && !sending) $('chat-img-input').click(); };
    $('chat-img-input').addEventListener('change', async e => {
        const file = e.target.files[0], recipient = activeChatCode; e.target.value = '';
        if (!file || !recipient || sending || deleting) return;
        sending = true; setChatControls();
        try { await sendMessage(await compressImage(file), recipient); } catch (error) { report(error); }
        finally { sending = false; setChatControls(); }
    });
    $('delete-chat-btn').onclick = async () => {
        const recipient = activeChatCode;
        if (!recipient || sending || deleting || !confirm('¿Borrar TODO el historial con este usuario? Esta acción es permanente.')) return;
        deleting = true; invalidateChat(); setChatControls();
        try { await api(`/mensajes/${enc(currentUser.codigo)}/${enc(recipient)}`, { method: 'DELETE' }); if (activeChatCode === recipient) { messages.clear(); olderAvailable = false; renderMessages(true); } }
        catch (error) { report(error); }
        finally { deleting = false; setChatControls(); await cargarMensajes(true); }
    };
    // One poll at a time, and no network work for hidden tabs.
    async function radar() {
        try {
            if (currentUser && !document.hidden && $('sec-perfil').classList.contains('active')) {
                const results = await Promise.allSettled([cargarContactos(), cargarMensajes()]);
                if (results[0].status === 'rejected') chatNotice.textContent = results[0].reason.message;
            }
        } finally { setTimeout(radar, 3000); }
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) invalidateChat(); else if (chatVisible()) cargarMensajes(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('photo-modal').style.display = 'none'; $('add-item-modal').style.display = 'none'; $('close-modal').click(); } });
    radar();
});
