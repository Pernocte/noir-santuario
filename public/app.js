'use strict';
document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const enc = encodeURIComponent;
    let currentUser = null, activeItemModalId = null, itemCategoryRef = '', currentCategoryToAdd = '';
    let activeChatCode = null, chatGeneration = 0, messageRequest = null, contactsRequest = null;
    let sending = false, deleting = false, olderAvailable = false;
    const messages = new Map(), galleryRequests = new Map();
    let contactsSignature = '', reviewRequest = null;
    const galleryCache = new Map(), drafts = new Map(), pendingSends = new Map();
    let attachment = null, preparingPhoto = false, photoSequence = 0;
    const photos = { item: null, user: null };
    const photoJobs = { item: null, user: null };
    const photoVersions = { item: 0, user: 0 };
    function notify(message, error = false) {
        const node = document.createElement('div'); node.className = `toast${error ? ' toast-error' : ''}`;
        node.textContent = message; node.tabIndex = 0; node.title = 'Toca para cerrar'; node.onclick = () => node.remove();
        $('toast-region').append(node);
        while ($('toast-region').children.length > 3) $('toast-region').firstChild.remove();
        setTimeout(() => node.remove(), 6000);
    }
    const alert = message => notify(message);
    function showDialog(dialog) { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
    function closeDialog(dialog) { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); }
    async function ask(message) {
        const dialog = $('confirm-dialog'); if (dialog.open) return false;
        $('confirm-message').textContent = message; showDialog(dialog);
        return new Promise(resolve => {
            const done = value => { closeDialog(dialog); dialog.removeEventListener('cancel', cancel); resolve(value); };
            const cancel = e => { e.preventDefault(); done(false); };
            $('confirm-accept').onclick = () => done(true); $('confirm-cancel').onclick = () => done(false);
            dialog.addEventListener('cancel', cancel);
        });
    }
    const report = error => { if (error.name !== 'AbortError') notify(error.message || 'No se pudo completar la operación.', true); };
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
    async function compressImage(file, maxSide = 1600) {
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
            const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('No se pudo comprimir la foto.')), file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', .78));
            return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('No se pudo preparar la foto.')); reader.readAsDataURL(blob); });
        } finally { URL.revokeObjectURL(url); }
    }
    function photoInput(id, key, labelId) {
        $(id).addEventListener('change', () => {
            const version = ++photoVersions[key], file = $(id).files[0];
            photos[key] = null;
            if (!file) { $(labelId).textContent = '+ Seleccionar imagen'; return; }
            $(labelId).textContent = 'Procesando foto...';
            photoJobs[key] = compressImage(file, key === 'user' ? 512 : 1600).then(data => {
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
            currentUser = data.user; document.body.classList.add('signed-in'); $('mobile-nav').hidden = false; $('my-nick').textContent = `@${currentUser.nombre}`; $('access-code').value = ''; $('code-error').style.display = 'none';
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
    function chatVisible() { return currentUser && activeChatCode && !document.hidden && $('sec-chat').classList.contains('active') && (innerWidth > 768 || $('mobile-chat-main').classList.contains('active-mobile')); }
    function invalidateChat() { chatGeneration++; messageRequest?.abort(); messageRequest = null; }
    function switchTab(id) {
        document.querySelectorAll('.nav-menu .nav-btn[data-target], #mobile-nav [data-target]').forEach(node => node.classList.toggle('active', node.dataset.target === id));
        document.querySelectorAll('.section-content').forEach(node => node.classList.toggle('active', node.id === id));
        document.body.classList.toggle('chat-mode', id === 'sec-chat');
        if (id !== 'sec-chat') invalidateChat();
        if (id === 'sec-chat') { cargarContactos().catch(report); if (chatVisible()) cargarMensajes(); }
        if (id === 'sec-modelos') cargarItems('modelos');
        if (id === 'sec-mercancia') cambiarSubCategoria(document.querySelector('.sub-nav-btn.active')?.dataset.subcat || 'juguetes');
    }
    document.querySelectorAll('.nav-menu .nav-btn[data-target], #mobile-nav [data-target]').forEach(node => node.addEventListener('click', () => switchTab(node.dataset.target)));
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
    async function cargarItems(category, refresh = false) {
        const grid = $(category === 'modelos' ? 'grid-modelos' : 'grid-mercancia-dinamico');
        // Never let a refresh from a modal replace a different selected category.
        if (category !== 'modelos' && document.querySelector('.sub-nav-btn.active')?.dataset.subcat !== category) return;
        galleryRequests.get(grid.id)?.abort();
        const controller = new AbortController(); galleryRequests.set(grid.id, controller);
        const cached = galleryCache.get(category);
        if (!cached || refresh || Date.now() - cached.at > 120000) {
            const skeletons = document.createDocumentFragment();
            for (let i = 0; i < 4; i++) { const skeleton = element('div', 'gallery-skeleton'); skeleton.setAttribute('aria-label', 'Cargando producto'); skeletons.append(skeleton); }
            grid.replaceChildren(skeletons);
        }
        try {
            const items = !refresh && cached && Date.now() - cached.at < 120000 ? cached.items : await api(`/items/${enc(category)}`, { signal: controller.signal });
            galleryCache.set(category, { items, at: cached && items === cached.items ? cached.at : Date.now() });
            if (galleryRequests.get(grid.id) !== controller) return;
            if (!Array.isArray(items)) throw new Error('Catálogo inválido.');
            const fragment = document.createDocumentFragment();
            for (const item of items) {
                const card = element('div', 'grid-item'); card.dataset.name = item.nombre.toLocaleLowerCase();
                const img = image(item.miniatura || item.imagen, 'grid-item-img', item.nombre);
                card.append(img, element('h3', 'catalog-name', item.nombre));
                if (currentUser.rol === 'admin') {
                    const del = element('button', 'del-btn', 'X'); del.style.display = 'block';
                    del.addEventListener('click', async e => {
                        e.stopPropagation(); if (del.disabled || !await ask('¿Eliminar permanentemente?')) return;
                        del.disabled = true;
                        try { await api(`/items/${item.id}`, { method: 'DELETE' }); await cargarItems(category, true); } catch (error) { report(error); del.disabled = false; }
                    }); card.append(del);
                }
                if (category === 'modelos') {
                    const actions = element('div', 'model-actions');
                    const view = element('button', 'gold-button', 'VER FOTO');
                    view.onclick = () => verFotoCompleta(item.imagen); img.onclick = view.onclick;
                    const contact = element('button', 'gold-button contact-model', `CONTACTAR ($${Number(item.precio).toFixed(2)})`);
                    contact.addEventListener('click', async () => {
                        if (contact.disabled || !await ask(`¿Desbloquear el contacto con ${item.nombre} por $${item.precio}?`)) return;
                        contact.disabled = true;
                        try { const data = await api('/modelos/contactar', { method: 'POST', body: { modeloId: item.id } }); actualizarSaldoUI(data.nuevoSaldo); alert(data.message); await cargarContactos(); }
                        catch (error) { report(error); } finally { contact.disabled = false; }
                    });
                    actions.append(view, contact); card.append(actions);
                } else {
                    if (Number(item.precio) > 0) card.append(element('p', 'item-price', `$${Number(item.precio).toFixed(2)}`));
                    card.append(element('p', 'item-stars-avg', Number(item.total_resenas) ? `★ ${Number(item.promedio_estrellas).toFixed(1)} (${item.total_resenas})` : 'Sin valoraciones'));
                    const rate = element('button', 'rate-product-button', '☆ Puntuar producto');
                    rate.addEventListener('click', e => { e.stopPropagation(); abrirModalItem(item, category); $('rating-caption').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); });
                    card.append(rate); card.tabIndex = 0; card.setAttribute('role', 'group'); card.setAttribute('aria-label', item.nombre);
                    card.addEventListener('keydown', e => { if (e.target === card && e.key === 'Enter') abrirModalItem(item, category); });
                    card.addEventListener('click', () => abrirModalItem(item, category));
                }
                fragment.append(card);
            }
            grid.replaceChildren(items.length ? fragment : element('p', 'load-status', 'No hay elementos en esta categoría.'));
            if (category !== 'modelos') filterCatalog();
        } catch (error) {
            if (controller.signal.aborted) return;
            const retry = element('button', 'gold-button', 'Reintentar'); retry.onclick = () => cargarItems(category, true);
            grid.replaceChildren(element('p', 'load-status', error.message), retry);
        }
    }
    function filterCatalog() {
        const query = $('catalog-search').value.trim().toLocaleLowerCase();
        const cards = [...$('grid-mercancia-dinamico').querySelectorAll('.grid-item')];
        cards.forEach(card => card.hidden = !card.dataset.name.includes(query));
        $('catalog-no-matches')?.remove();
        if (cards.length && cards.every(card => card.hidden)) { const empty = element('p', 'load-status', 'No hay productos con ese nombre.'); empty.id = 'catalog-no-matches'; $('grid-mercancia-dinamico').append(empty); }
    }
    $('catalog-search').addEventListener('input', filterCatalog);
    bind('refresh-catalog-btn', () => cargarItems(document.querySelector('.sub-nav-btn.active')?.dataset.subcat || 'juguetes', true));
    document.querySelectorAll('[data-open-chat]').forEach(button => button.onclick = () => switchTab('sec-chat'));
    bind('copy-nick-btn', async () => {
        try { await navigator.clipboard.writeText(currentUser.nombre); notify('Nick copiado. Compártelo con tus amigos.'); }
        catch { notify(`Tu nick es @${currentUser.nombre}`); }
    });
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
        $('lbl-item-foto').textContent = '+ Subir Fotografía'; $('add-item-modal').style.display = 'none'; await cargarItems(category, true);
    });
    bind('close-modal', () => { activeItemModalId = null; reviewRequest?.abort(); $('item-modal').style.display = 'none'; });
    function abrirModalItem(item, category) {
        activeItemModalId = item.id; itemCategoryRef = category;
        $('modal-title').textContent = item.nombre; background($('modal-img'), item.imagen);
        $('modal-price').textContent = `$${Number(item.precio).toFixed(2)}`;
        $('modal-price').style.display = $('buy-item-btn').style.display = Number(item.precio) > 0 ? 'block' : 'none';
        $('rating-caption').textContent = 'Elige de 1 a 5 estrellas'; $('rating-summary').textContent = ''; $('submit-review-btn').disabled = true;
        $('my-comment-text').value = ''; document.querySelectorAll('input[name="rating"]').forEach(node => node.checked = false);
        $('item-modal').style.display = 'flex'; cargarResenas(item.id);
    }
    async function cargarResenas(id) {
        reviewRequest?.abort(); const controller = new AbortController(); reviewRequest = controller;
        $('modal-comments').textContent = 'Cargando valoraciones...'; $('review-form-container').style.display = 'none'; $('already-reviewed-msg').style.display = 'none';
        try {
            const reviews = await api(`/items/${id}/resenas`, { signal: controller.signal });
            if (activeItemModalId !== id || controller.signal.aborted) return;
            $('rating-summary').textContent = reviews.length ? `★ ${(reviews.reduce((sum, r) => sum + Number(r.estrellas), 0) / reviews.length).toFixed(1)} · ${reviews.length} opiniones` : 'Sé la primera persona en opinar';
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
        if (!id || !await ask('¿Adquirir producto? Se descontará de tus fondos.')) return;
        const data = await api('/comprar', { method: 'POST', body: { itemId: id } }); actualizarSaldoUI(data.nuevoSaldo); alert(data.message);
        if (activeItemModalId === id) $('close-modal').click();
    });
    document.querySelectorAll('input[name="rating"]').forEach(radio => radio.addEventListener('change', () => {
        $('rating-caption').textContent = ['', 'No me gustó', 'Podría mejorar', 'Está bien', 'Me gustó', '¡Me encantó!'][Number(radio.value)];
        $('submit-review-btn').disabled = false;
    }));
    bind('submit-review-btn', async () => {
        const id = activeItemModalId, category = itemCategoryRef, rating = document.querySelector('input[name="rating"]:checked');
        if (!rating) throw new Error('Selecciona una calificación.');
        await api(`/items/${id}/resenas`, { method: 'POST', body: { estrellas: Number(rating.value), comentario: $('my-comment-text').value } });
        notify('¡Gracias! Tu opinión ya está publicada.');
        if (activeItemModalId === id) await cargarResenas(id); await cargarItems(category, true);
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
        try { const data = await compressImage(file, 512); await api('/perfil/foto', { method: 'POST', body: { nuevaFoto: data } }); currentUser.foto = data; background($('my-profile-pic'), data); }
        finally { e.target.value = ''; }
    }, 'change');
    async function addContact(alias) {
        if (!alias?.trim()) return;
        const data = await api('/contactos', { method: 'POST', body: { aliasContacto: alias.trim() } }); alert(data.message); await cargarContactos();
    }
    bind('add-contact-btn', () => { friendVersion++; $('friend-result').replaceChildren(); $('friend-nick').value = ''; showDialog($('friend-dialog')); $('friend-nick').focus(); });
    bind('close-friend-btn', () => { friendVersion++; closeDialog($('friend-dialog')); });
    let friendVersion = 0;
    $('friend-nick').addEventListener('input', () => { friendVersion++; $('friend-result').replaceChildren(); });
    $('friend-search-form').addEventListener('submit', async event => {
        event.preventDefault(); const version = ++friendVersion; const nick = $('friend-nick').value.trim().replace(/^@/, '');
        if (!nick) return; $('find-friend-btn').disabled = true; $('friend-result').textContent = 'Buscando…';
        try {
            const user = await api(`/usuarios/buscar?nick=${enc(nick)}`);
            if (version !== friendVersion) return;
            const card = element('div', 'friend-result-card'), avatar = image(user.foto, 'friend-avatar', user.nombre);
            const info = element('div', 'friend-info'); info.append(element('strong', '', user.nombre), element('span', '', `@${user.nombre}`));
            const add = element('button', 'gold-button', 'Agregar y conversar');
            add.onclick = async () => {
                if (add.disabled) return; add.disabled = true;
                try { await addContact(user.nombre); closeDialog($('friend-dialog')); switchTab('sec-chat'); openChat(user); }
                catch (error) { report(error); } finally { add.disabled = false; }
            };
            card.append(avatar, info, add); $('friend-result').replaceChildren(card);
        } catch (error) { if (version === friendVersion) $('friend-result').textContent = error.message; }
        finally { $('find-friend-btn').disabled = false; }
    });
    function filterContacts() {
        const query = $('contact-search').value.trim().toLocaleLowerCase();
        const rows = [...$('contact-list-container').querySelectorAll('.contact-item')];
        rows.forEach(row => row.hidden = !row.dataset.name.includes(query));
        $('contact-no-matches')?.remove();
        if (rows.length && rows.every(row => row.hidden)) { const empty = element('p', 'load-status', 'No encontramos esa conversación. Usa + Amigo para agregarla.'); empty.id = 'contact-no-matches'; $('contact-list-container').append(empty); }
    }
    $('contact-search').addEventListener('input', filterContacts);
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
            const unread = normalized.reduce((sum, c) => sum + Number(c.no_leidos || 0), 0);
            document.querySelectorAll('.unread-total').forEach(badge => { badge.hidden = !unread; badge.textContent = unread > 99 ? '99+' : String(unread); });
            const active = normalized.find(c => c.codigo === activeChatCode); if (active) updateHeader(active);
            if (signature === contactsSignature) return;
            contactsSignature = signature;
            const fragment = document.createDocumentFragment();
            for (const contact of normalized) {
                const row = element('div', 'contact-item'); row.dataset.codigo = contact.codigo; row.dataset.name = contact.nombre.toLocaleLowerCase(); row.tabIndex = 0; row.setAttribute('role', 'button'); row.classList.toggle('active', contact.codigo === activeChatCode);
                const avatar = element('div', 'contact-avatar'); background(avatar, contact.foto);
                if (contact.online) avatar.append(element('span', 'online-dot'));
                const details = element('div', 'contact-details');
                details.append(element('div', 'contact-name', contact.nombre), element('div', 'contact-preview', contact.ultimo_mensaje || 'Saluda a tu amigo 👋'));
                const meta = element('div', 'contact-meta'); meta.append(element('time', '', shortTime(contact.ultimo_fecha)));
                if (Number(contact.no_leidos)) meta.append(element('span', 'unread-badge', Number(contact.no_leidos) > 99 ? '99+' : contact.no_leidos));
                row.append(avatar, details, meta);
                row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(contact); } });
                row.addEventListener('click', () => openChat(contact)); fragment.append(row);
            }
            $('contact-list-container').replaceChildren(normalized.length ? fragment : element('p', 'load-status', 'Tu círculo empieza con un amigo. Toca + Amigo y busca su nick.')); filterContacts();
        })();
        try { await contactsRequest; } finally { contactsRequest = null; }
    }
    function setChatControls() {
        const disabled = !activeChatCode || sending || deleting || preparingPhoto;
        $('send-msg-btn').disabled = disabled; $('chat-img-btn').disabled = disabled; $('delete-chat-btn').disabled = disabled;
        $('chat-input').disabled = !activeChatCode || deleting;
    }
    function openChat(contact) {
        if (activeChatCode) drafts.set(activeChatCode, $('chat-input').value);
        clearAttachment(); invalidateChat(); activeChatCode = contact.codigo; messages.clear(); olderAvailable = false;
        $('chat-input').value = drafts.get(contact.codigo) || ''; resizeComposer(); $('chat-box').replaceChildren(element('p', 'load-status', 'Cargando mensajes...'));
        document.querySelectorAll('.contact-item').forEach(row => row.classList.toggle('active', row.dataset.codigo === contact.codigo));
        updateHeader(contact); $('delete-chat-btn').style.display = 'block';
        $('mobile-sidebar').classList.add('hidden-mobile'); $('mobile-chat-main').classList.add('active-mobile'); setChatControls(); renderPending(); cargarMensajes(true);
    }
    bind('back-to-contacts-btn', () => {
        if (activeChatCode) drafts.set(activeChatCode, $('chat-input').value);
        clearAttachment(); invalidateChat(); activeChatCode = null; messages.clear(); setChatControls();
        $('mobile-chat-main').classList.remove('active-mobile'); $('mobile-sidebar').classList.remove('hidden-mobile');
        $('delete-chat-btn').style.display = 'none'; $('chat-box').replaceChildren(element('p', 'load-status', 'Selecciona un contacto para chatear.'));
    });
    const chatNotice = element('div', 'chat-notice'); chatNotice.setAttribute('role', 'status'); $('chat-box').before(chatNotice);
    const olderButton = element('button', 'load-older', 'Cargar mensajes anteriores'); olderButton.hidden = true; $('chat-box').before(olderButton);
    olderButton.onclick = () => cargarMensajes(false, true);
    function shortTime(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); }
    function resizeComposer() { $('chat-input').style.height = 'auto'; $('chat-input').style.height = `${Math.min($('chat-input').scrollHeight || 42, 120)}px`; }
    $('chat-input').addEventListener('input', resizeComposer);
    function makeBubble(message) {
        const mine = message.remitente_codigo === currentUser.codigo;
        const bubble = element('div', `msg-bubble ${mine ? 'msg-sent' : 'msg-received'}`); bubble.dataset.id = message.id;
        if (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(message.mensaje)) {
            const img = image(message.mensaje, 'msg-image', 'Imagen de chat'); img.loading = 'eager';
            img.onclick = () => verFotoCompleta(message.mensaje);
            img.onload = () => { const box = $('chat-box'); if (bubble.dataset.keepBottom === '1') box.scrollTop = box.scrollHeight; };
            bubble.append(img);
        } else bubble.append(element('span', 'message-text', message.mensaje));
        bubble.append(element('time', 'message-time', shortTime(message.fecha)));
        if (mine) bubble.append(element('span', 'message-tick'));
        return bubble;
    }
    function renderMessages(force, previousHeight = null) {
        const box = $('chat-box'), atBottom = force || box.scrollHeight - box.scrollTop <= box.clientHeight + 100;
        box.querySelectorAll('.pending-message').forEach(node => node.remove());
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
        renderPending(); olderButton.hidden = !olderAvailable;
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
    function clearAttachment() {
        photoSequence++; attachment = null; preparingPhoto = false; $('attachment-preview').hidden = true;
        $('attachment-image').removeAttribute('src'); $('attachment-size').textContent = ''; setChatControls();
    }
    $('remove-attachment-btn').onclick = clearAttachment;
    function renderPending() {
        const box = $('chat-box'); box.querySelectorAll('.pending-message').forEach(node => node.remove());
        for (const pending of pendingSends.get(activeChatCode) || []) {
            const bubble = element('div', 'msg-bubble msg-sent pending-message');
            if (pending.content.startsWith('data:image/')) bubble.append(image(pending.content, 'msg-image', 'Foto pendiente'));
            else bubble.append(element('span', 'message-text', pending.content));
            bubble.append(element('div', 'send-status', pending.failed ? 'No se confirmó el envío. Comprueba el chat antes de reintentar.' : 'Enviando…'));
            if (pending.failed) {
                const retry = element('button', 'retry-send', 'Reintentar');
                retry.onclick = async () => {
                    if (sending || !await ask('El servidor podría haber recibido el mensaje. ¿Quieres reenviarlo?')) return;
                    sending = true; setChatControls(); pending.failed = false; renderPending();
                    try { await deliver(pending); } finally { sending = false; setChatControls(); }
                };
                const remove = element('button', 'retry-send', 'Descartar'); remove.onclick = () => { removePending(pending); renderPending(); };
                bubble.append(retry, remove);
            }
            box.querySelectorAll('.load-status').forEach(node => node.remove()); box.append(bubble);
        }
    }
    function removePending(pending) {
        const remaining = (pendingSends.get(pending.recipient) || []).filter(item => item !== pending);
        if (remaining.length) pendingSends.set(pending.recipient, remaining); else pendingSends.delete(pending.recipient);
    }
    async function deliver(pending) {
        try {
            await api('/mensajes', { method: 'POST', body: { destinatario: pending.recipient, mensaje: pending.content } });
            removePending(pending);
            if (activeChatCode === pending.recipient) { renderPending(); await cargarMensajes(true); }
            cargarContactos().catch(() => {});
        } catch (error) { pending.failed = true; renderPending(); report(error); }
    }
    async function enviarMensaje() {
        const input = $('chat-input'), recipient = activeChatCode;
        if (sending || deleting || preparingPhoto || !recipient) return;
        const photo = attachment?.recipient === recipient ? attachment.data : null, value = input.value;
        if (!photo && !value.trim()) return;
        const contents = [...(photo ? [photo] : []), ...(value.trim() ? [value] : [])];
        const pending = contents.map(content => ({ content, recipient, failed: false }));
        pendingSends.set(recipient, [...(pendingSends.get(recipient) || []), ...pending]);
        input.value = ''; drafts.delete(recipient); clearAttachment(); resizeComposer(); sending = true; setChatControls(); renderPending(); $('chat-box').scrollTop = $('chat-box').scrollHeight;
        try { for (const item of pending) await deliver(item); }
        finally { sending = false; setChatControls(); }
    }
    $('send-msg-btn').addEventListener('click', enviarMensaje);
    $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); enviarMensaje(); } });
    $('chat-img-btn').onclick = () => { if (activeChatCode && !sending) $('chat-img-input').click(); };
    $('chat-img-input').addEventListener('change', async e => {
        const file = e.target.files[0], recipient = activeChatCode; e.target.value = '';
        if (!file || !recipient || sending || deleting) return;
        const version = ++photoSequence; preparingPhoto = true; setChatControls(); chatNotice.textContent = 'Preparando tu foto…';
        try {
            const data = await compressImage(file, 1280);
            if (version !== photoSequence || recipient !== activeChatCode) return;
            attachment = { data, recipient }; $('attachment-image').src = data; $('attachment-preview').hidden = false;
            const bytes = Math.ceil(data.split(',')[1].length * .75);
            $('attachment-size').textContent = `${Math.ceil(bytes / 1024)} KB · Lista para enviar`;
        } catch (error) { if (version === photoSequence) report(error); }
        finally { if (version === photoSequence) { preparingPhoto = false; chatNotice.textContent = ''; setChatControls(); } }
    });
    $('delete-chat-btn').onclick = async () => {
        const recipient = activeChatCode;
        if (!recipient || sending || deleting || !await ask('¿Borrar TODO el historial con este usuario? Esta acción es permanente.')) return;
        deleting = true; invalidateChat(); setChatControls();
        try { await api(`/mensajes/${enc(currentUser.codigo)}/${enc(recipient)}`, { method: 'DELETE' }); pendingSends.delete(recipient); if (activeChatCode === recipient) { messages.clear(); olderAvailable = false; renderMessages(true); } }
        catch (error) { report(error); }
        finally { deleting = false; setChatControls(); await cargarMensajes(true); }
    };
    // One poll at a time, and no network work for hidden tabs.
    async function radar() {
        try {
            if (currentUser && !document.hidden) {
                const results = await Promise.allSettled([cargarContactos(), cargarMensajes()]);
                if (results[0].status === 'rejected') chatNotice.textContent = results[0].reason.message;
            }
        } finally { setTimeout(radar, 3000); }
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) invalidateChat(); else if (chatVisible()) cargarMensajes(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('photo-modal').style.display = 'none'; $('add-item-modal').style.display = 'none'; $('close-modal').click(); } });
    radar();
});
