const stages = [
  { id: 'new', label: 'Nuevo' },
  { id: 'negotiation', label: 'En negociación' },
  { id: 'quoted', label: 'Cotizado' },
  { id: 'won', label: 'Ganado' },
  { id: 'lost', label: 'Perdido' }
];

// Estos datos representan las etapas del negocio y se reutilizan en el pipeline,
// los filtros, los formularios y el panel administrativo.
let clients = [];
let linkedClients = [];
let appointments = [];
let clientsPage = 1;
let clientsPageCount = 1;
let clientsTotal = 0;
let clientSummary = { total: 0, won_value: 0, active_value: 0, lost_value: 0, forecast: 0, won_count: 0, lost_count: 0 };
let clientStageSummary = {};
let clientFollowUpCounts = { overdue: 0, today: 0, unscheduled: 0, stale: 0 };
const CLIENT_PAGE_SIZE = 50;
let currentUser = null;
let activeView = null;
let clientLayout = 'pipeline';
let locationPanelInitialized = false;
let locationMap = null;
let locationMarkers = [];
let locationHistoryPage = 1;
let locationHistoryFilters = { sellerId: '', from: '', to: '' };
let movementFilters = { from: '', to: '' };
let auditFilters = { from: '', to: '' };
let analysisFilters = { from: '', to: '' };

const pipeline = document.querySelector('#pipeline');
const search = document.querySelector('#search');
const stageFilter = document.querySelector('#stage-filter');
const followFilter = document.querySelector('#follow-filter');
const sortFilter = document.querySelector('#sort-filter');
const ownerFilter = document.querySelector('#owner-filter');
const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

async function api(path, options = {}) {
  // Centralizar fetch evita repetir la misma lectura de errores en cada botón.
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const responseText = await response.text();
  let payload = {};
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`El servidor devolvió una respuesta no válida (HTTP ${response.status}). Revisa los Logs de Render.`);
    }
  }
  if (!responseText && !response.ok) {
    throw new Error(`El servidor no devolvió detalles del error (HTTP ${response.status}). Revisa los Logs de Render.`);
  }
  if (!response.ok) throw new Error(payload.error || 'No se pudo completar la operación');
  return payload;
}

// ---------- Seguimiento: helpers ----------
const STALE_DAYS = 7;

function todayIso() { return new Date().toLocaleDateString('en-CA'); }
function isoInDays(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toLocaleDateString('en-CA'); }
function daysBetween(fromIso, toIso) { return Math.round((new Date(`${toIso}T00:00:00`) - new Date(`${fromIso}T00:00:00`)) / 86400000); }
function isOpen(client) { return !['won', 'lost'].includes(client.stage); }

function followUpStatus(client) {
  if (!isOpen(client)) return 'closed';
  if (!client.call_date) return 'unscheduled';
  const diff = daysBetween(todayIso(), client.call_date);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  return diff <= 3 ? 'soon' : 'later';
}
function daysSinceMovement(client) {
  // Cuenta desde el último contacto real; reprogramar una fecha no reinicia el contador.
  const last = client.last_contact_at || client.created_at;
  if (!last) return null;
  return daysBetween(String(last).slice(0, 10), todayIso());
}
function isStale(client) { return isOpen(client) && (daysSinceMovement(client) ?? 0) >= STALE_DAYS; }

// ---------- Contacto rápido ----------
function digits(value) { return String(value || '').replace(/\D/g, ''); }
function contactActions(client) {
  const phoneDigits = digits(client.contact_phone || client.company_phone);
  const greeting = `Hola ${client.contact}, soy ${currentUser?.name || ''} de Grubox Corrugados. Le escribo para dar seguimiento a su proyecto${client.box_type ? ` (${client.box_type})` : ''}.`;
  const links = [];
  if (phoneDigits) {
    links.push(`<a class="chip chip-link" href="tel:${phoneDigits}">📞 Llamar</a>`);
    const full = phoneDigits.length === 10 ? `52${phoneDigits}` : phoneDigits;
    links.push(`<a class="chip chip-link" href="https://wa.me/${full}?text=${encodeURIComponent(greeting)}" target="_blank" rel="noopener">💬 WhatsApp</a>`);
  }
  if (client.email) {
    links.push(`<a class="chip chip-link" href="mailto:${encodeURIComponent(client.email)}?subject=${encodeURIComponent('Seguimiento - Grubox Corrugados')}&body=${encodeURIComponent(greeting)}">✉ Correo</a>`);
  }
  return links.join('');
}

// ---------- Avisos ----------
function showToast(message, onClick) {
  let box = document.querySelector('#toast-box');
  if (!box) { box = document.createElement('div'); box.id = 'toast-box'; box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const toast = document.createElement('button');
  toast.type = 'button';
  toast.className = 'toast';
  toast.textContent = message;
  toast.addEventListener('click', () => { toast.remove(); if (onClick) onClick(); });
  box.append(toast);
  setTimeout(() => toast.remove(), 9000);
}

const remindedKeys = new Set();
function checkReminders() {
  // Recordatorio 10 minutos antes de la hora de contacto (solo vendedores, con la app abierta).
  if (currentUser?.role !== 'seller') return;
  api('/api/reminders').then(({ reminders }) => reminders.forEach(client => {
    const key = `${client.id}-${client.call_date}-${client.call_time}`;
    if (!remindedKeys.has(key)) {
      remindedKeys.add(key);
      const text = `Seguimiento con ${client.company} a las ${client.call_time}`;
      showToast(text, () => openFollowUp(client.id).catch(error => alert(error.message)));
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Grubox CRM', { body: text });
    }
  })).catch(() => {});
}

function announceFollowUps() {
  if (currentUser?.role !== 'seller') return;
  const counts = clientFollowUpCounts;
  if (!counts.overdue && !counts.today) return showToast('Estás al día: no tienes seguimientos para hoy.');
  showToast(`Tienes ${counts.overdue} vencido(s) y ${counts.today} para hoy. Toca para verlos.`, () => showView('today'));
}

function refreshFollowUpUI() {
  const counts = clientFollowUpCounts;
  const badge = document.querySelector('#today-badge');
  const pending = counts.overdue + counts.today;
  badge.textContent = pending;
  badge.hidden = pending === 0;
  if (activeView === 'today') showToday().catch(error => alert(error.message));
}

// ---------- Carga y filtrado ----------
function refreshOwnerFilter(owners = []) {
  if (currentUser?.role !== 'admin') return;
  const current = ownerFilter.value;
  ownerFilter.innerHTML = '<option value="all">Todos los vendedores</option>' + owners.map(owner => `<option value="${owner.id}">${escapeHtml(owner.name)}</option>`).join('');
  ownerFilter.value = owners.some(owner => String(owner.id) === current) ? current : 'all';
}

function clientListUrl(page = clientsPage, pageSize = CLIENT_PAGE_SIZE, useFilters = true) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (useFilters) {
    params.set('q', search.value.trim());
    params.set('stage', stageFilter.value);
    params.set('follow', followFilter.value);
    params.set('owner_id', ownerFilter.value);
    params.set('sort', sortFilter.value);
  }
  return `/api/clients?${params}`;
}

async function fetchClientPages(useFilters = true) {
  const first = await api(clientListUrl(1, 100, useFilters));
  const items = [...first.clients];
  for (let page = 2; page <= first.page_count; page++) {
    const next = await api(clientListUrl(page, 100, useFilters));
    items.push(...next.clients);
  }
  return { first, items };
}

async function loadClients({ resetPage = false } = {}) {
  if (resetPage) clientsPage = 1;
  if (activeView === 'today') {
    await loadAllClientsForCurrentView();
    await showToday();
    return;
  }
  const data = await api(clientListUrl());
  clients = data.clients;
  clientsPage = data.page;
  clientsPageCount = data.page_count;
  clientsTotal = data.total;
  clientSummary = data.summary;
  clientStageSummary = data.stage_summary;
  clientFollowUpCounts = data.followup_counts;
  refreshOwnerFilter(data.owners);
  render();
  refreshFollowUpUI();
}

async function loadAllClientsForCurrentView() {
  const { first, items } = await fetchClientPages(false);
  clients = items;
  clientsTotal = first.total;
  clientSummary = first.summary;
  clientSummary = first.summary;
  clientFollowUpCounts = first.followup_counts;
  refreshOwnerFilter(first.owners);
  refreshFollowUpUI();
}

function getVisibleClients() {
  return clients;
}

function render() {
  const visible = getVisibleClients();
  if (clientLayout === 'list') {
    pipeline.classList.add('prospect-list');
    pipeline.innerHTML = `<div class="audit-table"><table><thead><tr><th>Fecha</th><th>Vendedor</th><th>Cliente / prospecto</th><th>Tipo de oportunidad</th><th>Industria</th><th>Producto / medida</th><th>Valor oportunidad</th><th>Probabilidad</th><th>Forecast ponderado</th><th>Etapa</th><th>Fecha estimada cierre</th><th>Motivo / siguiente acción</th><th>Estado</th><th>Observaciones</th><th>Planta</th><th>Código MP</th><th>OC</th><th>Piezas / Kg</th><th>UM</th><th>Requerimiento planeado</th><th>Fecha de entrega</th><th>Proveedor</th><th>Captura por módulos</th><th>Acciones</th></tr></thead><tbody>${visible.map(client => `<tr><td>${escapeHtml(client.created_at || '')}</td><td>${escapeHtml(client.owner_name || '')}</td><td><strong>${escapeHtml(client.company)}</strong><span class="table-subtext">${escapeHtml(client.contact)}</span></td><td>${escapeHtml(client.opportunity_type || '')}</td><td>${escapeHtml(client.industry || '')}</td><td>${escapeHtml(client.product_measure || '')}</td><td>${money.format(client.value)}</td><td>${Number(client.probability || 0)}%</td><td>${money.format(client.weighted_forecast || 0)}</td><td>${escapeHtml(stageLabel(client.stage))}</td><td>${client.estimated_close_date ? escapeHtml(formatCalendarDate(client.estimated_close_date)) : ''}</td><td>${escapeHtml(client.next_action || '')}</td><td>${Number(client.capture_complete) === 0 ? `Captura pendiente · paso ${Number(client.capture_step || 1)} de 3` : client.stage === 'won' ? 'Ganada' : client.stage === 'lost' ? 'Perdida' : 'Activa'}</td><td>${escapeHtml(client.pinned_note || '')}</td><td>${escapeHtml(client.plant || '')}</td><td>${escapeHtml(client.material_code || '')}</td><td>${escapeHtml(client.purchase_order || '')}</td><td>${client.pieces_per_kg == null ? '' : escapeHtml(Number(client.pieces_per_kg).toLocaleString('es-MX'))}</td><td>${escapeHtml(client.unit_of_measure || '')}</td><td>${escapeHtml(client.planned_requirement || '')}</td><td>${client.expected_delivery_date || client.requested_delivery_date ? escapeHtml(formatCalendarDate(client.expected_delivery_date || client.requested_delivery_date)) : ''}</td><td>${escapeHtml(client.supplier || '')}</td><td>${renderCaptureSummary(client)}</td><td><div class="list-actions">${Number(client.capture_complete) === 0 ? `<button class="button button-primary continue-capture-button" data-id="${client.id}" type="button">Continuar</button>` : `<button class="button button-quiet follow-up-button" data-id="${client.id}" type="button" aria-label="Seguimiento de ${escapeHtml(client.company)}">◷</button><button class="button button-quiet edit-button" data-id="${client.id}" type="button">Editar</button>`}</div></td></tr>`).join('') || '<tr><td colspan="24">Sin registros</td></tr>'}</tbody></table></div>`;
  } else {
    pipeline.classList.remove('prospect-list');
    pipeline.innerHTML = stages.map(stage => {
      const stageClients = visible.filter(client => client.stage === stage.id);
      const aggregate = clientStageSummary[stage.id] || { count: 0, amount: 0 };
      const emptyMessage = aggregate.count ? 'Hay prospectos en otras páginas.' : 'Sin registros';
      return `<article class="stage" data-stage="${stage.id}"><div class="stage-heading"><span>${stage.label}</span><span class="stage-count">${aggregate.count}</span></div><p class="stage-total">${money.format(aggregate.amount)}</p><div class="stage-body">${stageClients.length ? stageClients.map(renderCard).join('') : `<p class="empty-stage">${emptyMessage}</p>`}</div></article>`;
    }).join('');
  }
  document.querySelector('#empty-state').hidden = clientsTotal > 0;
  document.querySelector('#total-count').textContent = clientSummary.total;
  document.querySelector('#won-value').textContent = money.format(clientSummary.won_value);
  document.querySelector('#active-value').textContent = money.format(clientSummary.active_value);
  document.querySelector('#lost-value').textContent = money.format(clientSummary.lost_value);
  const wonCount = Number(clientSummary.won_count || 0);
  const lostCount = Number(clientSummary.lost_count || 0);
  document.querySelector('#forecast-value').textContent = money.format(clientSummary.forecast);
  document.querySelector('#win-rate').textContent = `${wonCount + lostCount ? Math.round(wonCount / (wonCount + lostCount) * 100) : 0}%`;
  const pageStart = clientsTotal ? (clientsPage - 1) * CLIENT_PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(clientsPage * CLIENT_PAGE_SIZE, clientsTotal);
  document.querySelector('#client-page-status').textContent = `Mostrando ${pageStart}-${pageEnd} de ${clientsTotal} prospectos`;
  document.querySelector('#client-page-prev').disabled = clientsPage <= 1;
  document.querySelector('#client-page-next').disabled = clientsPage >= clientsPageCount;
  document.querySelector('#client-page-number').textContent = `Página ${clientsPage} de ${clientsPageCount}`;
  pipeline.querySelectorAll('.move-select').forEach(select => select.addEventListener('change', event => moveClient(event.target.dataset.id, event.target.value)));
}

function renderCard(client) {
  // Los datos que vienen del servidor pasan por escapeHtml antes de entrar al HTML.
  const call = client.call_date || client.call_time ? `Llamada: ${formatScheduledCall(client.call_date, client.call_time)}` : 'Sin llamada programada';
  const movement = client.last_to_stage ? `${client.last_from_stage ? `${stageLabel(client.last_from_stage)} → ` : ''}${stageLabel(client.last_to_stage)}` : 'Sin movimientos registrados';
  const contactData = [client.contact_phone, client.email, client.company_phone].filter(Boolean).map(escapeHtml).join(' · ');
  const contactLabels = { call: 'Llamada', whatsapp: 'WhatsApp', email: 'Correo electrónico', visit: 'Visita', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', instagram: 'Instagram' };
  const prospectDetails = [
    client.internal_code ? `Código: ${client.internal_code}` : '',
    client.preferred_contact ? `Contacto: ${contactLabels[client.preferred_contact] || client.preferred_contact}` : '',
    client.company_location ? `Ubicación: ${client.company_location}` : '',
    client.sample_provided === null || client.sample_provided === undefined ? '' : `Muestra: ${Number(client.sample_provided) ? 'Recibida' : 'No recibida'}`,
    client.drawing_provided === null || client.drawing_provided === undefined ? '' : `Plano: ${Number(client.drawing_provided) ? 'Recibido' : 'No recibido'}`,
    client.requested_delivery_date ? `Entrega solicitada: ${formatCalendarDate(client.requested_delivery_date)}` : '',
    client.expected_delivery_date ? `Entrega prevista: ${formatCalendarDate(client.expected_delivery_date)}` : ''
  ].filter(Boolean).map(escapeHtml).join(' · ');
  const pipelineDetails = [
    client.opportunity_type ? `Tipo: ${client.opportunity_type}` : '',
    client.industry ? `Industria: ${client.industry}` : '',
    client.product_measure ? `Producto / medida: ${client.product_measure}` : '',
    client.probability ? `Probabilidad: ${client.probability}%` : '',
    client.weighted_forecast ? `Forecast ponderado: ${money.format(client.weighted_forecast)}` : '',
    client.estimated_close_date ? `Cierre estimado: ${formatCalendarDate(client.estimated_close_date)}` : ''
  ].filter(Boolean).map(escapeHtml).join(' · ');
  const status = followUpStatus(client);
  const idle = isOpen(client) ? daysSinceMovement(client) : null;
  const badges = [
    Number(client.capture_complete) === 0 ? `<span class="badge badge-warn">Captura pendiente · paso ${Number(client.capture_step || 1)} de 3</span>` : '',
    status === 'overdue' ? '<span class="badge badge-overdue">Vencido</span>' : '',
    status === 'today' ? '<span class="badge badge-today">Hoy</span>' : '',
    status === 'unscheduled' ? '<span class="badge badge-warn">Sin seguimiento</span>' : '',
    idle !== null && idle >= STALE_DAYS ? `<span class="badge badge-idle">${idle} d sin actividad</span>` : ''
  ].join('');
  const deleteButton = currentUser?.role === 'admin' ? `<button class="delete-client" data-id="${client.id}" data-company="${escapeHtml(client.company)}" type="button">Eliminar prospecto</button>` : '';
  const shownValue = client.stage === 'won' && client.won_value !== null && client.won_value !== undefined ? client.won_value : client.value;
  const displayCompany = Number(client.capture_complete) === 0 && client.company === 'Oportunidad en captura' ? 'Oportunidad en captura' : client.company;
  return `<div class="client-card" data-stage="${client.stage}" data-follow="${status}" data-id="${client.id}" draggable="${Number(client.capture_complete) !== 0}">
    <h3>${escapeHtml(displayCompany)}</h3>
    ${badges ? `<div class="badge-row">${badges}</div>` : ''}
    <p>${escapeHtml(client.contact)}</p>
    ${contactData ? `<p class="contact-data">${contactData}</p>` : ''}
    ${prospectDetails ? `<p class="prospect-details">${prospectDetails}</p>` : ''}
    <p class="box-type">${escapeHtml(client.box_type || 'Tipo de caja pendiente')}</p>
    <p class="client-value">${money.format(shownValue)}</p>
    <p class="quantity-info">Cantidad estimada: ${Number(client.estimated_quantity || 0).toLocaleString('es-MX')}</p>
    ${pipelineDetails ? `<p class="prospect-details">${pipelineDetails}</p>` : ''}
    <p class="next-action">${escapeHtml(client.next_action)}</p>
    ${client.pinned_note ? `<p class="pinned-note">📌 ${escapeHtml(client.pinned_note)}</p>` : ''}${client.stage === 'lost' && client.lost_reason ? `<p class="lost-reason">Motivo: ${escapeHtml(client.lost_reason)}</p>` : ''}
    <div class="card-record">
      <p class="call-info">${escapeHtml(call)}</p>
      <p class="movement-info"><strong>Último movimiento:</strong> ${escapeHtml(movement)}${client.last_movement_at ? ` · ${escapeHtml(formatMovementTimestamp(client.last_movement_at))}` : ''}</p>
      ${client.last_note ? `<p class="movement-note">${escapeHtml(client.last_note)}</p>` : ''}
    </div>
    ${renderCaptureSummary(client)}
    ${isOpen(client) && Number(client.capture_complete) !== 0 ? `<div class="contact-actions">${contactActions(client)}</div>` : ''}
    <div class="card-actions">
      ${Number(client.capture_complete) === 0
        ? `<button class="button button-primary continue-capture-button" data-id="${client.id}" type="button">Continuar captura</button>`
        : `<button class="button button-quiet follow-up-button" data-id="${client.id}" type="button"><span aria-hidden="true">◷</span> Seguimiento</button>
           <button class="button button-quiet edit-button" data-id="${client.id}" type="button">✎ Editar</button>
           <label><span class="sr-only">Cambiar etapa</span><select class="move-select" data-id="${client.id}" aria-label="Cambiar etapa de ${escapeHtml(client.company)}">${stages.map(stage => `<option value="${stage.id}" ${stage.id === client.stage ? 'selected' : ''}>Mover a ${stage.label}</option>`).join('')}</select></label>`}
    </div>
    ${deleteButton}
  </div>`;
}

function renderCaptureSummary(client) {
  const completed = Number(client.capture_complete) !== 0;
  const captureStep = Number(client.capture_step || 1);
  const contactLabels = { call: 'Llamada', whatsapp: 'WhatsApp', email: 'Correo electrónico', visit: 'Visita', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', instagram: 'Instagram' };
  const modules = [
    {
      title: '1. Datos de la empresa',
      complete: completed || captureStep >= 2,
      fields: [
        ['Empresa', 'company'], ['Contacto', 'contact'], ['Medio de contacto', 'preferred_contact', value => contactLabels[value] || value],
        ['Teléfono de contacto', 'contact_phone'], ['Correo', 'email'],
        ['Teléfono de empresa', 'company_phone'], ['Ubicación de empresa', 'company_location']
      ]
    },
    {
      title: '2. Checklist para cotizar',
      complete: completed || captureStep >= 3,
      fields: [
        ['Dirección de entrega', 'delivery_address'], ['Condiciones de entrega', 'delivery_conditions'],
        ['Especificaciones', 'quote_specifications'], ['Flauta', 'flute'], ['Número de tintas', 'ink_count'],
        ['Medidas internas', 'internal_dimensions'], ['Medidas externas', 'external_dimensions'],
        ['Muestra física', 'sample_provided', value => Number(value) ? 'Sí' : 'No'],
        ['Tipo de liner', 'liner_type'], ['Tratamiento Mikelman', 'mikelman_treatment', value => Number(value) ? 'Sí' : 'No'],
        ['Tarima', 'pallet'], ['Volumen / piezas', 'estimated_quantity', value => Number(value).toLocaleString('es-MX')],
        ['Periodicidad', 'periodicity'], ['Forma de pago', 'payment_terms'],
        ['Altura máxima de tarima', 'max_pallet_height'],
        ['Precio estimado por pieza', 'target_price', value => money.format(value)],
        ['Tipo de caja / producto', 'box_type'],
        ['Plano', 'drawing_provided', value => Number(value) ? 'Sí' : 'No']
      ]
    },
    {
      title: '3. Pipeline comercial',
      complete: completed,
      fields: [
        ['Etapa', 'stage', value => stageLabel(value)], ['Tipo de oportunidad', 'opportunity_type'],
        ['Industria / sector', 'industry'], ['Producto / medida', 'product_measure'],
        ['Valor estimado', 'value', value => money.format(value)],
        ['Probabilidad', 'probability', value => `${Number(value)}%`],
        ['Forecast ponderado', 'weighted_forecast', value => money.format(value)],
        ['Fecha estimada de cierre', 'estimated_close_date'], ['Siguiente acción', 'next_action'],
        ['Fecha de seguimiento', 'call_date'], ['Hora de seguimiento', 'call_time'],
        ['Observaciones', 'pinned_note'], ['Importe real vendido', 'won_value', value => money.format(value)],
        ['Motivo de pérdida', 'lost_reason']
      ]
    }
  ];
  const tables = modules.map(module => {
    const rows = module.fields
      .filter(([, key]) => client[key] !== null && client[key] !== undefined
        && String(client[key]).trim() !== ''
        && !(['estimated_quantity', 'probability', 'weighted_forecast', 'value'].includes(key) && Number(client[key]) === 0))
      .map(([label, key, format]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(format ? format(client[key]) : client[key])}</td></tr>`)
      .join('');
    const status = module.complete ? 'Capturado' : 'Pendiente';
    const tableRows = rows || `<tr><td colspan="2" class="capture-empty">${module.complete ? 'Sin datos adicionales guardados.' : 'Pendiente por capturar.'}</td></tr>`;
    return `<section class="capture-module"><h4>${escapeHtml(module.title)} <span>${status}</span></h4><div class="capture-table-wrap"><table><tbody>${tableRows}</tbody></table></div></section>`;
  }).join('');
  return `<details class="capture-summary" ${completed ? '' : 'open'}><summary>Ver 3 tablas de captura</summary><div class="capture-modules">${tables}</div></details>`;
}

function formatCall(date, time) { return `${new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(new Date(`${date}T00:00:00`))} a las ${time}`; }
function formatScheduledCall(date, time) { if (date && time) return formatCall(date, time); if (date) return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(new Date(`${date}T00:00:00`)); return `a las ${time}`; }
function formatMovementTimestamp(value) { const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/); return match ? `${match[3]}/${match[2]}/${match[1]} ${match[4]}` : value; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }

async function moveClient(id, stage) {
  if (stage === 'won') {
    const client = clients.find(item => String(item.id) === String(id));
    if (!client) return;
    document.querySelector('#sale-company').textContent = client.company;
    document.querySelector('#sale-client-id').value = client.id;
    document.querySelector('#sale-form').elements.won_value.value = '';
    document.querySelector('#sale-dialog').showModal();
    return;
  }
  if (stage === 'lost') {
    const client = clients.find(item => String(item.id) === String(id));
    if (!client) return;
    document.querySelector('#lost-company').textContent = client.company;
    document.querySelector('#lost-client-id').value = client.id;
    document.querySelector('#lost-dialog').showModal();
    return;
  }
  try { await api(`/api/clients/${id}`, { method: 'PATCH', body: JSON.stringify({ stage }) }); await loadClients(); } catch (error) { alert(error.message); }
}

async function openFollowUp(id) {
  let client = clients.find(item => String(item.id) === String(id));
  if (!client) client = (await api(`/api/clients/${id}`)).client;
  if (!client) return;
  document.querySelector('#follow-up-company').textContent = client.company;
  document.querySelector('#follow-up-contact').innerHTML = contactActions(client);
  document.querySelector('#follow-up-id').value = client.id;
  document.querySelector('#call-date').value = client.call_date || '';
  document.querySelector('#call-time').value = client.call_time || '';
  document.querySelector('#follow-up-next-action').value = client.next_action || '';
  document.querySelector('#follow-up-type').value = 'call';
  document.querySelector('#follow-up-outcome').value = 'contacted';
  document.querySelector('#call-note').value = '';
  const data = await api(`/api/clients/${client.id}/history`);
  const followUpTypes = { call: 'Llamada', whatsapp: 'WhatsApp', email: 'Correo', visit: 'Visita', meeting: 'Reunión', other: 'Otro', reschedule: 'Reprogramado' };
  const followUpOutcomes = { contacted: 'Contacto realizado', no_answer: 'Sin respuesta', quote_requested: 'Solicitó cotización', quote_sent: 'Cotización enviada', sample_requested: 'Solicitó muestra', awaiting_customer: 'En espera del cliente', meeting_scheduled: 'Reunión programada', resolved: 'Seguimiento resuelto' };
  document.querySelector('#follow-up-history').innerHTML = data.history.length ? data.history.map(item => {
    const stageChange = item.from_stage && item.from_stage !== item.to_stage ? `${stageLabel(item.from_stage)} → ${stageLabel(item.to_stage)}` : stageLabel(item.to_stage);
    const activity = item.activity_type ? followUpTypes[item.activity_type] || item.activity_type : 'Cambio de etapa';
    const details = [item.outcome ? followUpOutcomes[item.outcome] || item.outcome : '', item.call_date ? `Próximo contacto: ${formatScheduledCall(item.call_date, item.call_time)}` : '', item.user_name, formatMovementTimestamp(item.created_at)].filter(Boolean).map(escapeHtml).join(' · ');
    return `<li><strong>${escapeHtml(activity)}${stageChange ? ` · ${escapeHtml(stageChange)}` : ''}</strong><span>${details}</span>${item.note ? `<em>${escapeHtml(item.note)}</em>` : ''}${item.next_action ? `<em><b>Próxima acción:</b> ${escapeHtml(item.next_action)}</em>` : ''}</li>`;
  }).join('') : '<li>Sin movimientos registrados.</li>';
  document.querySelector('#follow-up-dialog').showModal();
}
function stageLabel(id) { return stages.find(stage => stage.id === id)?.label || id || 'Sin etapa'; }
const appointmentResults = { pending: 'Pendiente', completed: 'Realizada', rescheduled: 'Reprogramada', canceled: 'Cancelada' };
function populateLinkedClientSelect(select, options) {
  linkedClients = options;
  select.innerHTML = linkedClients.map(client => `<option value="${client.id}">${escapeHtml(client.company)} · ${escapeHtml(client.contact)}</option>`).join('');
  select.disabled = linkedClients.length === 0;
}
function currentIsoWeek() {
  const date = new Date();
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function formatCalendarDate(value) { return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(new Date(`${value}T00:00:00`)); }

async function openAppointmentDialog() {
  if (!clientSummary.total) return alert('Agrega primero un prospecto para programar una cita.');
  const form = document.querySelector('#appointment-form');
  const { items } = await fetchClientPages(false);
  populateLinkedClientSelect(document.querySelector('#appointment-client'), items);
  const selectedClient = linkedClients.find(client => String(client.id) === document.querySelector('#appointment-client').value);
  form.elements.appointment_date.value = new Date().toLocaleDateString('en-CA');
  form.elements.appointment_time.value = '';
  form.elements.stage.value = selectedClient?.stage || 'new';
  form.elements.estimated_sale.value = selectedClient?.value || 0;
  document.querySelector('#appointment-dialog').showModal();
}

document.querySelector('#appointment-client').addEventListener('change', event => {
  const client = linkedClients.find(item => String(item.id) === event.target.value);
  const form = document.querySelector('#appointment-form');
  form.elements.stage.value = client?.stage || 'new';
  form.elements.estimated_sale.value = client?.value || 0;
});

async function showAppointments() {
  const data = await api('/api/appointments');
  appointments = data.appointments;
  const rows = appointments.map(item => `<tr><td>${formatCalendarDate(item.appointment_date)}</td><td>${escapeHtml(item.appointment_time)}</td><td><strong>${escapeHtml(item.company)}</strong><span class="table-subtext">${escapeHtml(item.contact)}</span></td><td>${escapeHtml(item.executive)}</td><td>${escapeHtml(item.appointment_type)}</td><td>${stageLabel(item.current_stage || item.stage)}</td><td>${money.format(item.estimated_sale)}</td><td><span class="appointment-status appointment-${item.result}">${appointmentResults[item.result] || 'Pendiente'}</span>${item.result_note ? `<span class="table-subtext">${escapeHtml(item.result_note)}</span>` : item.note ? `<span class="table-subtext">${escapeHtml(item.note)}</span>` : ''}${item.next_action ? `<span class="table-subtext"><strong>Siguiente:</strong> ${escapeHtml(item.next_action)}</span>` : ''}</td><td><button class="button button-quiet appointment-record-result" data-id="${item.id}" type="button">${item.result === 'pending' ? 'Registrar resultado' : 'Actualizar resultado'}</button></td></tr>`).join('');
  document.querySelector('#appointments-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Agenda / Seguimiento</p><h1>Citas comerciales</h1><p class="muted">Registra qué ocurrió en cada reunión y el avance comercial acordado.</p></div><button class="button button-primary" id="appointments-new-button" type="button">＋ Nueva cita</button></div><section class="data-panel appointment-panel"><div class="audit-table"><table><thead><tr><th>Fecha</th><th>Hora</th><th>Cliente / prospecto</th><th>Ejecutivo</th><th>Tipo de cita</th><th>Etapa actual</th><th>Venta estimada</th><th>Resultado y próximo paso</th><th>Acción</th></tr></thead><tbody>${rows || ''}</tbody></table>${rows ? '' : '<p class="empty-state">Todavía no hay citas programadas.</p>'}</div></section>`;
  document.querySelector('#appointments-new-button').addEventListener('click', openAppointmentDialog);
  document.querySelectorAll('.appointment-record-result').forEach(button => button.addEventListener('click', () => openAppointmentResult(button.dataset.id)));
}

function updateAppointmentResultFields() {
  const form = document.querySelector('#appointment-result-form');
  const result = form.elements.result.value;
  const stage = form.elements.stage.value;
  const completed = result === 'completed';
  const rescheduled = result === 'rescheduled';
  const won = stage === 'won';
  const lost = stage === 'lost';
  document.querySelector('#appointment-result-note').required = completed;
  document.querySelector('#appointment-result-date').required = rescheduled;
  document.querySelector('#appointment-result-won-field').hidden = !won;
  document.querySelector('#appointment-result-lost-field').hidden = !lost;
  form.elements.won_value.required = won;
  form.elements.lost_reason.required = lost;
}

function openAppointmentResult(id) {
  const appointment = appointments.find(item => String(item.id) === String(id));
  if (!appointment) return;
  const form = document.querySelector('#appointment-result-form');
  form.reset();
  form.elements.appointment_id.value = appointment.id;
  form.elements.result.value = appointment.result === 'pending' ? 'completed' : appointment.result;
  form.elements.stage.value = appointment.result_stage || appointment.current_stage || appointment.stage;
  form.elements.result_note.value = appointment.result_note || '';
  form.elements.next_action.value = appointment.next_action || '';
  form.elements.follow_up_date.value = appointment.follow_up_date || '';
  form.elements.follow_up_time.value = appointment.follow_up_time || '';
  form.elements.won_value.value = appointment.current_won_value ?? '';
  form.elements.lost_reason.value = appointment.current_lost_reason || '';
  document.querySelector('#appointment-result-title').textContent = appointment.company;
  document.querySelector('#appointment-result-context').textContent = `${formatCalendarDate(appointment.appointment_date)} · ${appointment.appointment_time} · ${appointment.appointment_type} · Etapa al agendar: ${stageLabel(appointment.stage)}`;
  updateAppointmentResultFields();
  document.querySelector('#appointment-result-dialog').showModal();
}

async function showAnalysis(appendToDashboard = false) {
  if (!analysisFilters.from) analysisFilters.from = `${todayIso().slice(0, 7)}-01`;
  if (!analysisFilters.to) analysisFilters.to = todayIso();
  const data = await api(`/api/analysis?${rangeQuery(analysisFilters)}`);
  const summary = data.summary;
  const completed = Number(summary.completed || 0);
  const advanced = Number(summary.advanced || 0);
  const advanceRate = completed ? Math.round(advanced / completed * 100) : 0;
  const pipelineStages = data.stages.filter(item => ['new', 'negotiation', 'quoted'].includes(item.stage));
  const activeCount = pipelineStages.reduce((total, item) => total + Number(item.count || 0), 0);
  const activeValue = pipelineStages.reduce((total, item) => total + Number(item.amount || 0), 0);
  const metrics = [
    { label: 'Citas agendadas', value: Number(summary.scheduled || 0), detail: `${Number(summary.rescheduled || 0)} reprogramadas` },
    { label: 'Reuniones realizadas', value: completed, detail: `${Number(summary.canceled || 0)} canceladas`, tone: 'completed' },
    { label: 'Avance comercial', value: `${advanceRate}%`, detail: `${advanced} de ${completed} reuniones realizadas`, tone: 'advanced' },
    { label: 'Oportunidades activas', value: activeCount.toLocaleString('es-MX'), detail: money.format(activeValue), tone: 'pipeline' }
  ];
  const resultItems = [
    { key: 'completed', label: 'Realizadas', value: completed, color: '#36a866' },
    { key: 'pending', label: 'Pendientes', value: Math.max(0, Number(summary.scheduled || 0) - completed - Number(summary.rescheduled || 0) - Number(summary.canceled || 0)), color: '#8da99a' },
    { key: 'rescheduled', label: 'Reprogramadas', value: Number(summary.rescheduled || 0), color: '#d49a24' },
    { key: 'canceled', label: 'Canceladas', value: Number(summary.canceled || 0), color: '#b54a3e' }
  ];
  const resultTotal = resultItems.reduce((total, item) => total + item.value, 0);
  let resultOffset = 0;
  const resultGradient = resultTotal ? `conic-gradient(${resultItems.map(item => {
    const start = resultOffset;
    resultOffset += item.value / resultTotal * 100;
    return `${item.color} ${start}% ${resultOffset}%`;
  }).join(', ')})` : 'conic-gradient(#d8e2da 0 100%)';
  const resultLegend = resultItems.map(item => `<div class="analysis-legend-item"><i style="--legend-color:${item.color}"></i><span>${item.label}</span><strong>${item.value}</strong></div>`).join('');
  const bucketCount = 8;
  const rangeStart = new Date(`${analysisFilters.from}T00:00:00`);
  const rangeEnd = new Date(`${analysisFilters.to}T23:59:59`);
  const rangeDuration = Math.max(1, rangeEnd.getTime() - rangeStart.getTime() + 1);
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const start = new Date(rangeStart.getTime() + rangeDuration * index / bucketCount);
    const end = new Date(rangeStart.getTime() + rangeDuration * (index + 1) / bucketCount - 1);
    return { start, end, scheduled: 0, completed: 0, rescheduled: 0, canceled: 0 };
  });
  data.events.forEach(item => {
    const eventDate = new Date(`${String(item.created_at).slice(0, 10)}T12:00:00`);
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((eventDate.getTime() - rangeStart.getTime()) / rangeDuration * bucketCount)));
    const bucket = buckets[index];
    if (item.event_type === 'scheduled') bucket.scheduled += 1;
    else if (item.result in { completed: true, rescheduled: true, canceled: true }) bucket[item.result] += 1;
  });
  const maxBucketValue = Math.max(...buckets.map(bucket => bucket.scheduled + bucket.completed + bucket.rescheduled + bucket.canceled), 1);
  const bucketLabel = bucket => new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' }).format(bucket.start);
  const activityBars = buckets.map(bucket => {
    const total = bucket.scheduled + bucket.completed + bucket.rescheduled + bucket.canceled;
    const bar = (key, label, color) => `<i class="analysis-bar-segment" title="${label}: ${bucket[key]}" style="--bar-height:${bucket[key] / maxBucketValue * 100}%;--bar-color:${color}"></i>`;
    return `<div class="analysis-bar-column"><strong>${total || ''}</strong><div class="analysis-bar-stack">${bar('scheduled', 'Agendadas', '#628d73')}${bar('completed', 'Realizadas', '#36a866')}${bar('rescheduled', 'Reprogramadas', '#d49a24')}${bar('canceled', 'Canceladas', '#b54a3e')}</div><span>${bucketLabel(bucket)}</span></div>`;
  }).join('');
  const stageMax = Math.max(...data.stages.map(item => Number(item.count || 0)), 1);
  const stageRows = stages.map((stage, index) => {
    const item = data.stages.find(row => row.stage === stage.id);
    const count = Number(item?.count || 0);
    const amount = Number(item?.amount || 0);
    return `<div class="analysis-stage-row"><span>${stage.label}</span><div class="analysis-stage-track"><i style="width:${count / stageMax * 100}%;--stage-color:${['#8da99a', '#628d73', '#d49a24', '#36a866', '#b54a3e'][index]}"></i></div><strong>${count}</strong><span>${money.format(amount)}</span></div>`;
  }).join('');
  const resultLabels = { pending: 'Pendiente', completed: 'Realizada', rescheduled: 'Reprogramada', canceled: 'Cancelada' };
  const eventRows = data.events.map(item => {
    const stageMovement = item.previous_stage && item.current_stage
      ? `${stageLabel(item.previous_stage)} → ${stageLabel(item.current_stage)}`
      : stageLabel(item.current_stage);
    const nextContact = item.follow_up_date ? `Próximo contacto: ${formatScheduledCall(item.follow_up_date, item.follow_up_time)}` : '';
    return `<tr><td>${escapeHtml(formatMovementTimestamp(item.created_at))}</td><td>${escapeHtml(formatCalendarDate(item.appointment_date))}<span class="table-subtext">${escapeHtml(item.appointment_time)} · ${escapeHtml(item.appointment_type)}</span></td><td><strong>${escapeHtml(item.company)}</strong><span class="table-subtext">${escapeHtml(item.user_name)}</span></td><td>${item.event_type === 'scheduled' ? 'Cita agendada' : escapeHtml(resultLabels[item.result] || item.result)}</td><td>${escapeHtml(stageMovement)}</td><td>${item.note ? escapeHtml(item.note) : '<span class="table-subtext">Sin detalle</span>'}${item.next_action ? `<span class="table-subtext"><strong>Siguiente acción:</strong> ${escapeHtml(item.next_action)}</span>` : ''}${nextContact ? `<span class="table-subtext">${escapeHtml(nextContact)}</span>` : ''}</td></tr>`;
  }).join('');
  const scope = currentUser.role === 'admin' ? 'Todos los vendedores' : 'Tus prospectos';
  const advanceNarrative = advanced ? `${advanced} oportunidad(es) avanzaron tras una cita.` : 'Aún no hay avances de etapa registrados.';
  const analysisTarget = document.querySelector('#analysis-render-target');
  analysisTarget.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Rendimiento / Decisiones comerciales</p><h1>Análisis de seguimiento</h1><p class="muted">Citas, resultados y cambios de etapa · ${scope}</p></div>${rangeControls('analysis', analysisFilters)}</div><section class="analysis-metrics">${metrics.map(metric => `<article class="analysis-metric ${metric.tone ? `analysis-${metric.tone}` : ''}"><span>${metric.label}</span><strong>${metric.value}</strong><small>${metric.detail}</small></article>`).join('')}</section><div class="analysis-chart-grid"><section class="data-panel analysis-activity-chart"><div class="panel-heading"><div><h2>Actividad en el periodo</h2><span>Registro de citas por fecha</span></div><div class="analysis-chart-legend"><span><i class="legend-scheduled"></i>Agendadas</span><span><i class="legend-completed"></i>Realizadas</span><span><i class="legend-rescheduled"></i>Reprogramadas</span><span><i class="legend-canceled"></i>Canceladas</span></div></div>${data.events.length ? `<div class="analysis-bar-chart" role="img" aria-label="Actividad de citas agrupada en ocho intervalos del periodo">${activityBars}</div>` : '<p class="empty-state">No hay actividad de citas en este periodo.</p>'}</section><section class="data-panel analysis-outcome-chart"><div class="panel-heading"><div><h2>Resultado de citas</h2><span>Distribución del periodo</span></div></div><div class="analysis-outcome-layout"><div class="analysis-donut" role="img" aria-label="${resultTotal} citas consideradas" style="--donut-chart:${resultGradient}"><div><strong>${resultTotal}</strong><span>citas</span></div></div><div class="analysis-outcome-legend">${resultLegend}</div></div></section></div><div class="analysis-grid"><section class="data-panel analysis-pipeline"><div class="panel-heading"><div><h2>Pipeline actual</h2><span>Oportunidades y valor por etapa</span></div></div>${stageRows}</section><section class="data-panel analysis-insight"><p class="eyebrow">Lectura del periodo</p><h2>${advanceNarrative}</h2><p>${completed ? `${completed} de ${Number(summary.scheduled || 0)} citas programadas terminaron realizadas. ${Number(summary.stayed || 0)} oportunidad(es) continuaron en la misma etapa.` : 'Registra el resultado de las reuniones para identificar qué oportunidades avanzan.'}</p><button class="button button-quiet" id="analysis-open-appointments" type="button">Ver agenda de citas</button></section></div><details class="data-panel analysis-events"><summary><span><strong>Historial detallado</strong><small>${data.events.length} eventos · máximo 300 por consulta</small></span><span class="analysis-details-icon" aria-hidden="true">⌄</span></summary><div class="audit-table"><table><thead><tr><th>Registrado</th><th>Fecha de cita</th><th>Prospecto / ejecutivo</th><th>Resultado</th><th>Etapa</th><th>Acuerdos y próxima acción</th></tr></thead><tbody>${eventRows}</tbody></table>${eventRows ? '' : '<p class="empty-state">No hay citas ni resultados en este periodo.</p>'}</div></details>`;
  const dashboard = document.querySelector('#dashboard-page');
  const analysisPanel = document.createElement('section');
  analysisPanel.id = 'dashboard-analysis';
  analysisPanel.className = 'dashboard-analysis';
  analysisPanel.innerHTML = analysisTarget.innerHTML;
  analysisTarget.replaceChildren();
  const heading = analysisPanel.querySelector('.page-heading');
  if (appendToDashboard) {
    const title = document.createElement('h2');
    title.textContent = 'Análisis de seguimiento';
    heading.querySelector('h1').replaceWith(title);
    heading.className = 'dashboard-section-heading';
    dashboard.querySelector('#dashboard-analysis')?.remove();
    dashboard.append(analysisPanel);
  } else {
    heading.querySelector('h1').textContent = 'Dashboard de seguimiento';
    heading.querySelector('.eyebrow').textContent = 'Rendimiento / Decisiones comerciales';
    dashboard.replaceChildren(analysisPanel);
  }
  bindRange('analysis', analysisFilters, () => showAnalysis(appendToDashboard));
  analysisPanel.querySelector('#analysis-open-appointments').addEventListener('click', () => showView('appointments'));
  const analysisStagesTitle = analysisPanel.querySelector('.analysis-pipeline h2');
  if (analysisStagesTitle) analysisStagesTitle.textContent = 'Oportunidades por etapa';
}

async function showKpis(week = currentIsoWeek()) {
  const data = await api(`/api/kpis?week=${encodeURIComponent(week)}`);
  const activities = Object.fromEntries((data.activities || []).map(item => [item.activity_type, item]));
  const count = type => Number(activities[type]?.count || 0);
  const amount = type => Number(activities[type]?.amount || 0);
  const prospecting = count('prospecting_call') + count('prospecting_email');
  const quotes = count('quote_sent');
  const sales = count('sale_closed');
  const quotedClients = Number(data.quote_stats?.quoted_clients || 0);
  const convertedClients = Number(data.quote_stats?.converted_clients || 0);
  const conversion = quotedClients ? Math.round(convertedClients / quotedClients * 100) : 0;
  const metrics = [
    { label: 'Prospectos nuevos · llamadas y correos', value: prospecting, target: '30–50', minimum: 30 },
    { label: 'Contactos efectivos', value: count('effective_contact'), target: '15–25', minimum: 15 },
    { label: 'Cotizaciones enviadas', value: quotes, target: '8–15', minimum: 8, detail: money.format(amount('quote_sent')) + ' cotizado' },
    { label: 'Seguimientos realizados', value: count('follow_up'), target: '15–25', minimum: 15 },
    { label: 'Nuevas oportunidades', value: count('new_opportunity'), target: '5–10', minimum: 5 },
    { label: 'Muestras / prototipos solicitados', value: count('sample_requested'), target: '2–5', minimum: 2 },
    { label: 'Ventas cerradas', value: sales, target: '2–5', minimum: 2, detail: money.format(amount('sale_closed')) + ' vendido' }
  ];
  const start = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(new Date(`${data.week_start}T00:00:00`));
  document.querySelector('#kpis-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Rendimiento / Semana comercial</p><h1>Indicadores semanales</h1><p class="muted">Actividad registrada · semana desde ${start}</p></div><label class="week-picker">Semana<input id="kpi-week" type="week" value="${escapeHtml(week)}"></label></div><section class="kpi-grid">${metrics.map(metric => `<article class="kpi-row"><div class="kpi-label"><strong>${metric.label}</strong><span>Meta sugerida: ${metric.target}</span></div><div class="kpi-track"><i style="width:${Math.min(100, metric.value / metric.minimum * 100)}%"></i></div><div class="kpi-value"><strong>${metric.value.toLocaleString('es-MX')}</strong>${metric.detail ? `<span>${metric.detail}</span>` : ''}</div></article>`).join('')}</section><section class="summary kpi-summary"><div><span>Monto cotizado</span><strong>${money.format(amount('quote_sent'))}</strong></div><div><span>Monto vendido</span><strong>${money.format(amount('sale_closed'))}</strong></div><div><span>Conversión cotizado a ganado</span><strong>${conversion}%</strong><small>${convertedClients} de ${quotedClients} prospectos</small></div><div><span>Citas programadas</span><strong>${Number(data.appointments || 0)}</strong></div></section><p class="kpi-note">La conversión sigue a los prospectos con cotización enviada en la semana seleccionada que actualmente están ganados. Las metas son referencias iniciales.</p>`;
  document.querySelector('#kpi-week').addEventListener('change', event => showKpis(event.target.value).catch(error => alert(error.message)));
}

// ---------- Vista "Seguimiento" (Mi día) ----------
async function snoozeFollowUp(id, days) {
  const client = clients.find(item => String(item.id) === String(id));
  if (!client) return;
  await api(`/api/clients/${id}/reschedule`, { method: 'PATCH', body: JSON.stringify({ call_date: isoInDays(days), call_time: client.call_time || '' }) });
  await loadClients();
}

function followUpRow(client) {
  const status = followUpStatus(client);
  const idle = daysSinceMovement(client);
  const when = client.call_date ? formatScheduledCall(client.call_date, client.call_time) : 'Sin fecha programada';
  const late = status === 'overdue' ? ` · ${Math.abs(daysBetween(todayIso(), client.call_date))} d de retraso` : '';
  return `<article class="follow-row follow-${status}">
    <div class="follow-main">
      <strong>${escapeHtml(client.company)}</strong>
      <span>${escapeHtml(client.contact)} · ${stageLabel(client.stage)} · ${money.format(client.value)}</span>
      <span class="follow-next">${escapeHtml(client.next_action || 'Sin próxima acción')}</span>
      ${client.pinned_note ? `<span class="pinned-note">📌 ${escapeHtml(client.pinned_note)}</span>` : ''}
      <span class="follow-meta">${escapeHtml(when)}${late}${idle !== null ? ` · último contacto hace ${idle} d` : ''}</span>
      ${client.last_note ? `<em>${escapeHtml(client.last_note)}</em>` : ''}
    </div>
    <div class="follow-actions">
      <div class="contact-actions">${contactActions(client)}</div>
      <button class="button button-primary" type="button" data-follow="${client.id}">Registrar seguimiento</button>
      <div class="chip-row"><span class="chip-label">Reprogramar:</span>
        <button class="chip" type="button" data-snooze="1" data-id="${client.id}">Mañana</button>
        <button class="chip" type="button" data-snooze="3" data-id="${client.id}">+3 d</button>
        <button class="chip" type="button" data-snooze="7" data-id="${client.id}">+1 sem</button>
      </div>
    </div>
  </article>`;
}

async function weeklyProgress() {
  try {
    const data = await api(`/api/kpis?week=${currentIsoWeek()}`);
    const counts = Object.fromEntries((data.activities || []).map(item => [item.activity_type, Number(item.count || 0)]));
    const items = [['Seguimientos', counts.follow_up || 0, 15], ['Contactos efectivos', counts.effective_contact || 0, 15], ['Cotizaciones enviadas', counts.quote_sent || 0, 8]];
    return `<section class="data-panel goal-panel"><div class="panel-heading"><h2>Meta de la semana</h2><span>Mínimos sugeridos</span></div>${items.map(([label, value, target]) => `<div class="chart-row"><span>${label}</span><div class="chart-track"><i style="width:${Math.min(100, value / target * 100)}%"></i></div><strong>${value}/${target}</strong></div>`).join('')}</section>`;
  } catch { return ''; }
}

async function showToday() {
  const groups = { overdue: [], today: [], soon: [], unscheduled: [], stale: [] };
  clients.filter(isOpen).forEach(client => {
    const status = followUpStatus(client);
    if (status === 'later') { if (isStale(client)) groups.stale.push(client); }
    else if (groups[status]) groups[status].push(client);
  });
  const byDate = (a, b) => `${a.call_date || ''}${a.call_time || ''}`.localeCompare(`${b.call_date || ''}${b.call_time || ''}`);
  groups.overdue.sort(byDate); groups.today.sort(byDate); groups.soon.sort(byDate);
  groups.unscheduled.sort((a, b) => Number(b.value) - Number(a.value));
  groups.stale.sort((a, b) => (daysSinceMovement(b) || 0) - (daysSinceMovement(a) || 0));

  const atRisk = [...groups.overdue, ...groups.unscheduled].reduce((sum, client) => sum + Number(client.value), 0);
  const sections = [
    ['overdue', 'Vencidos', 'Atiéndelos primero'],
    ['today', 'Para hoy', 'Ordenados por hora'],
    ['soon', 'Próximos 3 días', 'Prepárate con tiempo'],
    ['unscheduled', 'Sin seguimiento programado', 'Agenda una fecha'],
    ['stale', 'Enfriándose', `Más de ${STALE_DAYS} días sin contacto`]
  ];
  const progress = currentUser?.role === 'seller' ? await weeklyProgress() : '';
  const canNotify = 'Notification' in window && Notification.permission === 'default';
  document.querySelector('#today-page').innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">Ventas / Mi día</p><h1>Seguimiento</h1><p class="muted">Lo que necesitas atender hoy para no perder oportunidades.</p></div>${canNotify ? '<button class="button button-quiet" type="button" data-enable-notify>🔔 Activar avisos del navegador</button>' : ''}</div>
    <section class="summary follow-summary">
      <div><span>Vencidos</span><strong class="text-overdue">${groups.overdue.length}</strong></div>
      <div><span>Para hoy</span><strong>${groups.today.length}</strong></div>
      <div><span>Próximos 3 días</span><strong>${groups.soon.length}</strong></div>
      <div><span>Sin seguimiento</span><strong>${groups.unscheduled.length}</strong></div>
      <div><span>Dinero en riesgo</span><strong>${money.format(atRisk)}</strong><small>Vencidos + sin fecha</small></div>
    </section>
    ${progress}
    ${sections.map(([key, title, hint]) => groups[key].length ? `<section class="data-panel follow-group"><div class="panel-heading"><h2>${title} <span class="stage-count">${groups[key].length}</span></h2><span>${hint}</span></div>${groups[key].map(followUpRow).join('')}</section>` : '').join('')}
    ${Object.values(groups).every(list => !list.length) ? '<p class="empty-state">🎉 No tienes seguimientos pendientes. Buen trabajo.</p>' : ''}`;
}

document.querySelector('#today-page').addEventListener('click', async event => {
  const follow = event.target.closest('[data-follow]');
  const snooze = event.target.closest('[data-snooze]');
  try {
    if (follow) await openFollowUp(follow.dataset.follow);
    else if (snooze) await snoozeFollowUp(snooze.dataset.id, Number(snooze.dataset.snooze));
    else if (event.target.closest('[data-enable-notify]')) { await Notification.requestPermission(); await showToday(); }
  } catch (error) { alert(error.message); }
});

// ---------- Exportar CSV ----------
async function exportCsv() {
  const cols = [
    ['created_at', 'Fecha'], ['owner_name', 'Vendedor'], ['company', 'Empresa'], ['contact', 'Contacto'],
    ['contact_phone', 'Teléfono'], ['email', 'Correo'], ['company_phone', 'Teléfono empresa'],
    ['company_location', 'Ubicación empresa'], ['preferred_contact', 'Medio de contacto'],
    ['opportunity_type', 'Tipo de oportunidad'], ['industry', 'Industria / sector'],
    ['product_measure', 'Producto / medida'], ['value', 'Valor estimado de oportunidad'],
    ['probability', 'Probabilidad (%)'], ['weighted_forecast', 'Forecast ponderado'],
    ['stage', 'Etapa'], ['estimated_close_date', 'Fecha estimada de cierre'],
    ['next_action', 'Motivo / siguiente acción'], ['status', 'Estado'], ['pinned_note', 'Observaciones'],
    ['delivery_address', 'Dirección de entrega'], ['delivery_conditions', 'Condiciones de entrega'],
    ['quote_specifications', 'Especificaciones a cotizar'], ['flute', 'Flauta'], ['ink_count', 'Número de tintas'],
    ['internal_dimensions', 'Medidas internas'], ['external_dimensions', 'Medidas externas'],
    ['sample_provided', 'Muestra física'], ['liner_type', 'Tipo de liner'],
    ['mikelman_treatment', 'Tratamiento Mikelman'], ['pallet', 'Tarima'],
    ['estimated_quantity', 'Volumen / cantidad de piezas'], ['periodicity', 'Periodicidad'],
    ['payment_terms', 'Forma de pago'], ['max_pallet_height', 'Altura máxima de tarima'],
    ['target_price', 'Precio estimado por pieza'], ['plant', 'Planta'], ['material_code', 'Código MP'],
    ['purchase_order', 'OC'], ['pieces_per_kg', 'Piezas / Kg'], ['unit_of_measure', 'UM'],
    ['planned_requirement', 'Requerimiento planeado'], ['supplier', 'Proveedor'],
    ['won_value', 'Importe vendido'], ['lost_reason', 'Motivo de pérdida'], ['call_date', 'Próximo contacto']
  ];
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`; // evita fórmulas en Excel
    return `"${text.replace(/"/g, '""')}"`;
  };
  const { items } = await fetchClientPages(true);
  const rows = items.map(c => cols.map(([key]) => cell(key === 'stage' ? stageLabel(c.stage) : key === 'status' ? (c.stage === 'won' ? 'Ganada' : c.stage === 'lost' ? 'Perdida' : 'Activa') : key === 'sample_provided' ? (c.sample_provided == null ? '' : Number(c.sample_provided) ? 'Sí' : 'No') : c[key])).join(','));
  const csv = '\ufeff' + [cols.map(([, label]) => cell(label)).join(','), ...rows].join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `prospectos-${todayIso()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Alta de prospectos: el navegador organiza la captura; el servidor valida y guarda.
const clientForm = document.querySelector('#client-form');
const clientFormSteps = [...clientForm.querySelectorAll('[data-form-step]')];
const clientStepLabels = ['Datos de la empresa', 'Checklist para cotizar', 'Pipeline comercial'];
let clientFormStep = 0;
function showClientFormStep(step) {
  clientFormStep = step;
  clientFormSteps.forEach((section, index) => { section.hidden = index !== step; });
  document.querySelector('#client-step-caption').textContent = `Paso ${step + 1} de 3 · ${clientStepLabels[step]}`;
  document.querySelectorAll('.wizard-progress span').forEach((label, index) => label.classList.toggle('wizard-step-active', index === step));
  document.querySelector('#client-step-back').hidden = step === 0;
  document.querySelector('#client-step-next').hidden = step === clientFormSteps.length - 1;
  document.querySelector('#client-submit').hidden = step !== clientFormSteps.length - 1;
  document.querySelector('#client-save-progress').hidden = step === clientFormSteps.length - 1;
}
function syncCompanyDeliveryAddress(form, useCompanyLocation) {
  const companyLocation = form.elements.companyLocation || form.elements.company_location;
  const deliveryAddress = form.elements.deliveryAddress || form.elements.delivery_address;
  if (useCompanyLocation.checked) deliveryAddress.value = companyLocation.value;
  deliveryAddress.readOnly = useCompanyLocation.checked;
}
const useCompanyLocation = clientForm.elements.useCompanyLocation;
useCompanyLocation.addEventListener('change', () => syncCompanyDeliveryAddress(clientForm, useCompanyLocation));
clientForm.elements.companyLocation.addEventListener('input', () => {
  if (useCompanyLocation.checked) syncCompanyDeliveryAddress(clientForm, useCompanyLocation);
});
const productMeasureDifferent = clientForm.elements.productMeasureDifferent;
productMeasureDifferent.addEventListener('change', () => {
  document.querySelector('#product-measure-field').hidden = productMeasureDifferent.value !== '1';
});
document.querySelector('#client-step-next').addEventListener('click', () => {
  const controls = [...clientFormSteps[clientFormStep].querySelectorAll('input, select, textarea')];
  const invalid = controls.find(control => !control.checkValidity());
  if (invalid) { invalid.reportValidity(); return; }
  const hasData = controls.some(control => control.type === 'checkbox'
    ? control.checked
    : !control.readOnly && String(control.value || '').trim() !== '');
  if (!hasData) return alert('Captura al menos un dato de este módulo antes de continuar.');
  saveClientProgress(false, true);
});
document.querySelector('#client-step-back').addEventListener('click', () => showClientFormStep(clientFormStep - 1));
function updateWeightedForecast() {
  const value = Number(clientForm.elements.value.value || 0);
  const probability = Number(clientForm.elements.probability.value || 0);
  clientForm.elements.weightedForecast.value = (value * probability / 100).toFixed(2);
}
function updateOpportunityValue() {
  const price = Number(clientForm.elements.targetPrice.value || 0);
  const quantity = Number(clientForm.elements.estimatedQuantity.value || 0);
  clientForm.elements.value.value = String(Math.round(price * quantity));
  updateWeightedForecast();
}
['targetPrice', 'estimatedQuantity'].forEach(name => clientForm.elements[name].addEventListener('input', updateOpportunityValue));
clientForm.elements.probability.addEventListener('input', updateWeightedForecast);
document.querySelector('#client-stage').addEventListener('change', event => {
  const stage = event.target.value;
  const isWon = stage === 'won';
  const isLost = stage === 'lost';
  document.querySelector('#new-won-value-field').hidden = !isWon;
  document.querySelector('#new-lost-reason-field').hidden = !isLost;
  clientForm.elements.wonValue.required = isWon;
  clientForm.elements.lostReason.required = isLost;
  document.querySelector('#client-pipeline-status').value = isWon ? 'Ganado' : isLost ? 'Perdido' : 'Activo';
});
function clientFormPayload(complete, advance = false) {
  const form = new FormData(clientForm);
  const optionalNumber = name => form.get(name) === '' ? null : Number(form.get(name));
  return {
    client_id: form.get('clientId'),
    capture_step: complete ? 3 : clientFormStep + (advance ? 2 : 1),
    capture_complete: complete ? 1 : 0,
    company: form.get('company'), contact: form.get('contact'),
    contact_phone: form.get('contactPhone'), email: form.get('email'),
    company_phone: form.get('companyPhone'), company_location: form.get('companyLocation'),
    preferred_contact: form.get('preferredContact'), stage: form.get('stage'),
    won_value: optionalNumber('wonValue'), value: optionalNumber('value') || 0,
    lost_reason: form.get('lostReason'),
    estimated_quantity: optionalNumber('estimatedQuantity') || 0,
    box_type: form.get('boxType'), next_action: form.get('nextAction'),
    call_date: form.get('callDate'), call_time: form.get('callTime'),
    sample_provided: optionalNumber('sampleProvided'), drawing_provided: optionalNumber('drawingProvided'),
    delivery_address: useCompanyLocation.checked ? form.get('companyLocation') : form.get('deliveryAddress'), delivery_conditions: form.get('deliveryConditions'),
    quote_specifications: form.get('quoteSpecifications'), flute: form.get('flute'),
    ink_count: optionalNumber('inkCount'), internal_dimensions: form.get('internalDimensions'),
    external_dimensions: form.get('externalDimensions'), liner_type: form.get('linerType'),
    mikelman_treatment: form.get('mikelmanTreatment'), pallet: form.get('pallet'),
    periodicity: form.get('periodicity'), payment_terms: form.get('paymentTerms'),
    max_pallet_height: form.get('maxPalletHeight'), target_price: optionalNumber('targetPrice'),
    opportunity_type: form.get('opportunityType'), industry: form.get('industry'),
    product_measure: productMeasureDifferent.value === '1' ? form.get('productMeasure') : form.get('boxType'), probability: Number(form.get('probability') || 0),
    estimated_close_date: form.get('estimatedCloseDate'), pinned_note: form.get('pinnedNote')
  };
}
async function saveClientProgress(complete, advance = false) {
  const payload = clientFormPayload(complete, advance);
  if (!complete && ['won', 'lost'].includes(payload.stage)) {
    return alert('Para cerrar como Ganado o Perdido, termina primero la captura de la oportunidad.');
  }
  if (complete) {
    for (const name of ['company', 'contact', 'nextAction', 'estimatedQuantity', 'targetPrice', 'sampleProvided', 'drawingProvided']) {
      const control = clientForm.elements[name];
      if (!String(control.value || '').trim()) {
        showClientFormStep(name === 'estimatedQuantity' || name === 'targetPrice' ? 1 : 2);
        control.focus();
        return alert(`Completa el campo "${control.labels?.[0]?.textContent || name}" para guardar la oportunidad.`);
      }
    }
    if (payload.stage === 'won' && payload.won_value == null) {
      showClientFormStep(2);
      clientForm.elements.wonValue.focus();
      return alert('Captura el importe real vendido para finalizar como Ganado.');
    }
    if (payload.stage === 'lost' && !String(payload.lost_reason || '').trim()) {
      showClientFormStep(2);
      clientForm.elements.lostReason.focus();
      return alert('Indica el motivo de pérdida para finalizar como Perdido.');
    }
    const invalid = [...clientForm.querySelectorAll('input[type="email"], input[type="number"]')].find(control => control.value && !control.checkValidity());
    if (invalid) { invalid.reportValidity(); return; }
  }
  try {
    let clientId = payload.client_id;
    delete payload.client_id;
    if (clientId) {
      const closingStage = ['won', 'lost'].includes(payload.stage) ? payload.stage : null;
      if (closingStage) {
        delete payload.stage;
      }
      await api(`/api/clients/${clientId}/edit`, { method: 'PATCH', body: JSON.stringify(payload) });
      if (closingStage) {
        await api(`/api/clients/${clientId}`, { method: 'PATCH', body: JSON.stringify({
          stage: closingStage,
          won_value: payload.won_value,
          lost_reason: payload.lost_reason
        }) });
      }
    } else {
      const result = await api('/api/clients', { method: 'POST', body: JSON.stringify(payload) });
      clientId = result.id;
    }
    if (advance) {
      clientForm.elements.clientId.value = clientId;
      await loadClients();
      showClientFormStep(clientFormStep + 1);
      return;
    }
    resetClientForm();
    document.querySelector('#client-dialog').close();
    await loadClients();
    if (!complete) alert('Avance guardado. Puedes retomarlo desde la tarjeta del prospecto.');
  } catch (error) { alert(error.message); }
}
document.querySelector('#client-save-progress').addEventListener('click', () => saveClientProgress(false));
document.querySelector('#client-submit').addEventListener('click', () => saveClientProgress(true));
showClientFormStep(0);
document.querySelector('#sale-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api(`/api/clients/${form.get('client_id')}`, { method: 'PATCH', body: JSON.stringify({ stage: 'won', won_value: Number(form.get('won_value')) }) });
    event.target.closest('dialog').close();
    await loadClients();
  } catch (error) { alert(error.message); }
});
document.querySelector('#appointment-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  payload.client_id = Number(payload.client_id);
  payload.estimated_sale = Number(payload.estimated_sale);
  try {
    await api('/api/appointments', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    document.querySelector('#appointment-dialog').close();
    if (activeView === 'appointments') await showAppointments();
  } catch (error) { alert(error.message); }
});
document.querySelector('#appointment-result-status').addEventListener('change', updateAppointmentResultFields);
document.querySelector('#appointment-result-stage').addEventListener('change', updateAppointmentResultFields);
document.querySelector('#appointment-result-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  const appointmentId = payload.appointment_id;
  delete payload.appointment_id;
  if (payload.won_value) payload.won_value = Number(payload.won_value);
  try {
    await api(`/api/appointments/${appointmentId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    event.target.closest('dialog').close();
    await loadClients();
    if (activeView === 'appointments') await showAppointments();
    if (activeView === 'dashboard') await showDashboard();
  } catch (error) { alert(error.message); }
});
document.querySelector('#activity-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = { client_id: Number(form.get('client_id')), activity_type: form.get('activity_type'), amount: Number(form.get('amount') || 0), note: form.get('note') };
  try {
    await api('/api/activities', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    document.querySelector('#quote-amount-field').hidden = true;
    document.querySelector('#quote-amount').required = false;
    document.querySelector('#activity-dialog').close();
    if (activeView === 'kpis') await showKpis(document.querySelector('#kpi-week').value);
  } catch (error) { alert(error.message); }
});
document.querySelector('#new-client').addEventListener('click', () => { resetClientForm(); document.querySelector('#client-dialog').showModal(); });
function resetClientForm() {
  clientForm.reset();
  clientForm.elements.clientId.value = '';
  document.querySelector('#client-dialog h2').textContent = 'Agregar prospecto';
  document.querySelector('#client-dialog .eyebrow').textContent = 'Nueva oportunidad';
  document.querySelector('#new-won-value-field').hidden = true;
  document.querySelector('#new-lost-reason-field').hidden = true;
  clientForm.elements.wonValue.required = false;
  clientForm.elements.lostReason.required = false;
  document.querySelector('#client-pipeline-status').value = 'Activo';
  syncCompanyDeliveryAddress(clientForm, useCompanyLocation);
  document.querySelector('#product-measure-field').hidden = true;
  updateOpportunityValue();
  showClientFormStep(0);
}
document.querySelector('#close-dialog').addEventListener('click', () => { resetClientForm(); document.querySelector('#client-dialog').close(); });
document.querySelector('#cancel-dialog').addEventListener('click', () => { resetClientForm(); document.querySelector('#client-dialog').close(); });
document.querySelector('#sale-close').addEventListener('click', () => document.querySelector('#sale-dialog').close());
document.querySelector('#sale-cancel').addEventListener('click', () => document.querySelector('#sale-dialog').close());
document.querySelector('#new-appointment').addEventListener('click', openAppointmentDialog);
document.querySelector('#appointment-close').addEventListener('click', () => document.querySelector('#appointment-dialog').close());
document.querySelector('#appointment-cancel').addEventListener('click', () => document.querySelector('#appointment-dialog').close());
document.querySelector('#appointment-result-close').addEventListener('click', () => document.querySelector('#appointment-result-dialog').close());
document.querySelector('#appointment-result-cancel').addEventListener('click', () => document.querySelector('#appointment-result-dialog').close());
document.querySelector('#new-activity').addEventListener('click', async () => {
  if (!clientSummary.total) return alert('Agrega primero un prospecto para registrar una actividad.');
  try {
    const { items } = await fetchClientPages(false);
    populateLinkedClientSelect(document.querySelector('#activity-client'), items);
    document.querySelector('#activity-form').reset();
    document.querySelector('#quote-amount-field').hidden = true;
    document.querySelector('#quote-amount').required = false;
    document.querySelector('#activity-dialog').showModal();
  } catch (error) { alert(error.message); }
});
document.querySelector('#activity-close').addEventListener('click', () => document.querySelector('#activity-dialog').close());
document.querySelector('#activity-cancel').addEventListener('click', () => document.querySelector('#activity-dialog').close());
document.querySelector('#activity-type').addEventListener('change', event => {
  const isQuote = event.target.value === 'quote_sent';
  document.querySelector('#quote-amount-field').hidden = !isQuote;
  document.querySelector('#quote-amount').required = isQuote;
});

// Búsqueda con pequeña espera para no redibujar en cada tecla.
let searchTimer;
search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadClients({ resetPage: true }).catch(error => alert(error.message)), 250); });
[stageFilter, followFilter, sortFilter, ownerFilter].forEach(control => control.addEventListener('change', () => loadClients({ resetPage: true }).catch(error => alert(error.message))));
document.querySelector('#client-page-prev').addEventListener('click', () => { clientsPage -= 1; loadClients().catch(error => alert(error.message)); });
document.querySelector('#client-page-next').addEventListener('click', () => { clientsPage += 1; loadClients().catch(error => alert(error.message)); });
document.querySelector('#pipeline-view').addEventListener('click', () => setClientLayout('pipeline'));
document.querySelector('#list-view').addEventListener('click', () => setClientLayout('list'));
function setClientLayout(layout) {
  clientLayout = layout;
  document.querySelector('#pipeline-view').classList.toggle('view-switch-active', layout === 'pipeline');
  document.querySelector('#pipeline-view').setAttribute('aria-pressed', String(layout === 'pipeline'));
  document.querySelector('#list-view').classList.toggle('view-switch-active', layout === 'list');
  document.querySelector('#list-view').setAttribute('aria-pressed', String(layout === 'list'));
  render();
}
document.querySelector('#export-csv').addEventListener('click', () => exportCsv().catch(error => alert(error.message)));

// Atajos: "/" busca, "n" crea prospecto
document.addEventListener('keydown', event => {
  if (event.target.matches('input, textarea, select') || document.querySelector('dialog[open]')) return;
  if (event.key === '/') { event.preventDefault(); showView('clients').then(() => search.focus()); }
  if (event.key === 'n') { event.preventDefault(); showView('clients').then(() => document.querySelector('#new-client').click()); }
});

// ---------- Diálogo de seguimiento ----------
document.querySelector('#follow-up-close').addEventListener('click', () => document.querySelector('#follow-up-dialog').close());
document.querySelector('#follow-up-cancel').addEventListener('click', () => document.querySelector('#follow-up-dialog').close());
document.querySelector('#follow-up-form').addEventListener('submit', async event => { event.preventDefault(); const form = new FormData(event.target); try { await api(`/api/clients/${form.get('client_id')}`, { method: 'PATCH', body: JSON.stringify({ call_date: form.get('call_date'), call_time: form.get('call_time'), note: form.get('note'), activity_type: form.get('activity_type'), outcome: form.get('outcome'), next_action: form.get('next_action') }) }); event.target.closest('dialog').close(); await loadClients(); } catch (error) { alert(error.message); } });
document.querySelector('#date-chips').addEventListener('click', event => {
  const chip = event.target.closest('[data-days]');
  if (!chip) return;
  document.querySelector('#call-date').value = isoInDays(Number(chip.dataset.days));
  if (!document.querySelector('#call-time').value) document.querySelector('#call-time').value = '10:00';
});
document.querySelector('#next-action-chips').addEventListener('click', event => {
  const chip = event.target.closest('[data-action-text]');
  if (chip) document.querySelector('#follow-up-next-action').value = chip.dataset.actionText;
});
// Sugerencia de próxima fecha según el resultado (el vendedor puede cambiarla)
const outcomeSuggestedDays = { no_answer: 1, quote_requested: 1, quote_sent: 3, awaiting_customer: 5, sample_requested: 7 };
document.querySelector('#follow-up-outcome').addEventListener('change', event => {
  const days = outcomeSuggestedDays[event.target.value];
  if (days) document.querySelector('#call-date').value = isoInDays(days);
});

pipeline.addEventListener('click', event => { const button = event.target.closest('.follow-up-button'); if (button) openFollowUp(button.dataset.id).catch(error => alert(error.message)); });
pipeline.addEventListener('click', event => { const button = event.target.closest('.delete-client'); if (button) deleteClient(button.dataset.id, button.dataset.company); });
async function deleteClient(id, company) { if (!window.confirm(`¿Eliminar el prospecto "${company}"? Se borrará su historial de movimientos y no se podrá recuperar.`)) return; try { await api(`/api/clients/${id}`, { method: 'DELETE' }); await loadClients(); } catch (error) { alert(error.message); } }
document.querySelector('#today').textContent = new Intl.DateTimeFormat('es-MX', { dateStyle: 'long' }).format(new Date());

// ---------- Arrastrar y soltar entre etapas ----------
pipeline.addEventListener('dragstart', event => {
  const card = event.target.closest('.client-card');
  if (!card || Number(clients.find(item => String(item.id) === card.dataset.id)?.capture_complete) === 0) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData('text/plain', card.dataset.id);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
pipeline.addEventListener('dragend', () => {
  pipeline.querySelectorAll('.dragging, .drop-target').forEach(element => element.classList.remove('dragging', 'drop-target'));
});
pipeline.addEventListener('dragover', event => {
  const stage = event.target.closest('.stage');
  if (!stage) return;
  event.preventDefault();
  stage.classList.add('drop-target');
});
pipeline.addEventListener('dragleave', event => {
  const stage = event.target.closest('.stage');
  if (stage && !stage.contains(event.relatedTarget)) stage.classList.remove('drop-target');
});
pipeline.addEventListener('drop', event => {
  const stage = event.target.closest('.stage');
  if (!stage) return;
  event.preventDefault();
  stage.classList.remove('drop-target');
  const id = event.dataTransfer.getData('text/plain');
  const client = clients.find(item => String(item.id) === id);
  // Reutiliza moveClient: "Ganado" pide el importe real y "Perdido" el motivo.
  if (client && client.stage !== stage.dataset.stage) moveClient(id, stage.dataset.stage);
});

// ---------- Motivo de pérdida ----------
document.querySelector('#lost-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api(`/api/clients/${form.get('client_id')}`, { method: 'PATCH', body: JSON.stringify({ stage: 'lost', lost_reason: form.get('reason') }) });
    event.target.closest('dialog').close();
    await loadClients();
  } catch (error) { alert(error.message); }
});
document.querySelector('#lost-close').addEventListener('click', () => document.querySelector('#lost-dialog').close());
document.querySelector('#lost-cancel').addEventListener('click', () => document.querySelector('#lost-dialog').close());
// Si se cierra sin confirmar (Esc, cancelar), se restaura la etapa real en pantalla.
['#sale-dialog', '#lost-dialog'].forEach(selector => document.querySelector(selector).addEventListener('close', () => loadClients().catch(() => {})));

// ---------- Editar prospecto ----------
async function openEditDialog(id) {
  const client = clients.find(item => String(item.id) === String(id));
  if (!client) return;
  const form = document.querySelector('#edit-form');
  form.elements.client_id.value = client.id;
  ['company', 'contact', 'contact_phone', 'email', 'company_phone', 'company_location', 'internal_code', 'value', 'weighted_forecast', 'estimated_quantity', 'box_type', 'preferred_contact', 'requested_delivery_date', 'expected_delivery_date', 'pinned_note', 'plant', 'material_code', 'purchase_order', 'pieces_per_kg', 'unit_of_measure', 'planned_requirement', 'supplier', 'delivery_address', 'delivery_conditions', 'quote_specifications', 'flute', 'ink_count', 'internal_dimensions', 'external_dimensions', 'liner_type', 'mikelman_treatment', 'pallet', 'periodicity', 'payment_terms', 'max_pallet_height', 'target_price', 'probability', 'opportunity_type', 'industry', 'product_measure', 'estimated_close_date', 'next_action']
    .forEach(name => { form.elements[name].value = client[name] ?? ''; });
  form.elements.use_company_location.checked = Boolean(client.company_location && client.company_location === client.delivery_address);
  syncCompanyDeliveryAddress(form, form.elements.use_company_location);
  form.elements.product_measure_different.value = client.product_measure && client.product_measure !== client.box_type ? '1' : '0';
  syncEditProductMeasure(form);
  updateEditOpportunityValue(form);
  form.elements.sample_provided.value = Number(client.sample_provided || 0);
  form.elements.drawing_provided.value = Number(client.drawing_provided || 0);
  if (currentUser.role === 'admin') {
    const { users } = await api('/api/admin/users');
    document.querySelector('#edit-owner').innerHTML = users.filter(user => user.role === 'seller' && user.active)
      .map(user => `<option value="${user.id}" ${user.id === client.owner_id ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('');
  }
  document.querySelector('#edit-dialog').showModal();
}
function updateEditOpportunityValue(form, priceWasChanged = false) {
  if (form.elements.target_price.value || priceWasChanged) {
    const price = Number(form.elements.target_price.value || 0);
    const quantity = Number(form.elements.estimated_quantity.value || 0);
    form.elements.value.value = String(Math.round(price * quantity));
  }
  updateEditWeightedForecast(form);
}
function updateEditWeightedForecast(form) {
  const value = Number(form.elements.value.value || 0);
  const probability = Number(form.elements.probability.value || 0);
  form.elements.weighted_forecast.value = (value * probability / 100).toFixed(2);
}
const editForm = document.querySelector('#edit-form');
function syncEditProductMeasure(form) {
  const isDifferent = form.elements.product_measure_different.value === '1';
  document.querySelector('#edit-product-measure-field').hidden = !isDifferent;
  form.elements.product_measure.readOnly = !isDifferent;
  if (!isDifferent) form.elements.product_measure.value = form.elements.box_type.value;
}
editForm.elements.product_measure_different.addEventListener('change', () => syncEditProductMeasure(editForm));
editForm.elements.box_type.addEventListener('input', () => {
  if (editForm.elements.product_measure_different.value !== '1') syncEditProductMeasure(editForm);
});
editForm.elements.target_price.addEventListener('input', () => updateEditOpportunityValue(editForm, true));
editForm.elements.estimated_quantity.addEventListener('input', () => updateEditOpportunityValue(editForm));
editForm.elements.probability.addEventListener('input', () => updateEditWeightedForecast(editForm));
editForm.elements.use_company_location.addEventListener('change', () => syncCompanyDeliveryAddress(editForm, editForm.elements.use_company_location));
editForm.elements.company_location.addEventListener('input', () => {
  if (editForm.elements.use_company_location.checked) syncCompanyDeliveryAddress(editForm, editForm.elements.use_company_location);
});
pipeline.addEventListener('click', event => {
  const button = event.target.closest('.edit-button');
  if (button) openEditDialog(button.dataset.id).catch(error => alert(error.message));
});
pipeline.addEventListener('click', event => {
  const button = event.target.closest('.continue-capture-button');
  if (button) openClientDraft(button.dataset.id);
});
function openClientDraft(id) {
  const client = clients.find(item => String(item.id) === String(id));
  if (!client) return;
  resetClientForm();
  clientForm.elements.clientId.value = client.id;
  const fieldMap = {
    company: 'company', contact: 'contact', preferredContact: 'preferred_contact',
    contactPhone: 'contact_phone', email: 'email', companyPhone: 'company_phone',
    companyLocation: 'company_location', stage: 'stage', wonValue: 'won_value',
    lostReason: 'lost_reason',
    deliveryAddress: 'delivery_address', deliveryConditions: 'delivery_conditions',
    quoteSpecifications: 'quote_specifications', flute: 'flute', inkCount: 'ink_count',
    internalDimensions: 'internal_dimensions', externalDimensions: 'external_dimensions',
    sampleProvided: 'sample_provided', linerType: 'liner_type',
    mikelmanTreatment: 'mikelman_treatment', pallet: 'pallet',
    estimatedQuantity: 'estimated_quantity', periodicity: 'periodicity',
    paymentTerms: 'payment_terms', maxPalletHeight: 'max_pallet_height',
    targetPrice: 'target_price', boxType: 'box_type', drawingProvided: 'drawing_provided',
    opportunityType: 'opportunity_type', industry: 'industry', productMeasure: 'product_measure',
    value: 'value', probability: 'probability', estimatedCloseDate: 'estimated_close_date',
    nextAction: 'next_action', callDate: 'call_date', callTime: 'call_time', pinnedNote: 'pinned_note'
  };
  Object.entries(fieldMap).forEach(([formName, clientName]) => {
    clientForm.elements[formName].value = client[clientName] ?? '';
  });
  useCompanyLocation.checked = Boolean(client.company_location && client.company_location === client.delivery_address);
  syncCompanyDeliveryAddress(clientForm, useCompanyLocation);
  productMeasureDifferent.value = client.product_measure && client.product_measure !== client.box_type ? '1' : '0';
  productMeasureDifferent.dispatchEvent(new Event('change'));
  updateOpportunityValue();
  if (client.company === 'Oportunidad en captura') clientForm.elements.company.value = '';
  if (client.contact === 'Por definir') clientForm.elements.contact.value = '';
  if (client.next_action === 'Continuar captura') clientForm.elements.nextAction.value = '';
  clientForm.elements.stage.dispatchEvent(new Event('change'));
  updateWeightedForecast();
  document.querySelector('#client-dialog h2').textContent = 'Continuar captura';
  document.querySelector('#client-dialog .eyebrow').textContent = 'Oportunidad en borrador';
  showClientFormStep(Math.min(2, Math.max(0, Number(client.capture_step || 1) - 1)));
  document.querySelector('#client-dialog').showModal();
}
document.querySelector('#edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  const id = payload.client_id;
  delete payload.client_id;
  ['value', 'estimated_quantity', 'sample_provided', 'drawing_provided'].forEach(key => { payload[key] = Number(payload[key]); });
  if (currentUser.role !== 'admin') delete payload.owner_id;
  try {
    await api(`/api/clients/${id}/edit`, { method: 'PATCH', body: JSON.stringify(payload) });
    event.target.closest('dialog').close();
    await loadClients();
  } catch (error) { alert(error.message); }
});
document.querySelector('#edit-close').addEventListener('click', () => document.querySelector('#edit-dialog').close());
document.querySelector('#edit-cancel').addEventListener('click', () => document.querySelector('#edit-dialog').close());

// ---------- Filtros de fecha (Movimientos y Auditoría) ----------
function rangeQuery(filters) { const p = new URLSearchParams(); if (filters.from) p.set('from', filters.from); if (filters.to) p.set('to', filters.to); return p.toString(); }
function rangeControls(prefix, filters) {
  return `<div class="location-filters"><label>Desde<input id="${prefix}-from" type="date" value="${escapeHtml(filters.from)}"></label><label>Hasta<input id="${prefix}-to" type="date" value="${escapeHtml(filters.to)}"></label><button class="button button-quiet" id="${prefix}-clear" type="button">Limpiar</button></div>`;
}
function bindRange(prefix, filters, reload) {
  ['from', 'to'].forEach(key => document.querySelector(`#${prefix}-${key}`).addEventListener('change', event => { filters[key] = event.target.value; reload().catch(error => alert(error.message)); }));
  document.querySelector(`#${prefix}-clear`).addEventListener('click', () => { filters.from = ''; filters.to = ''; reload().catch(error => alert(error.message)); });
}

// ---------- Panel gerencial ----------
async function showDashboard() {
  if (currentUser?.role !== 'admin') {
    await showAnalysis(false);
    return;
  }
  const year = Number(document.querySelector('#dashboard-year')?.value || new Date().getFullYear());
  const data = await api(`/api/admin/dashboard?year=${year}`);
  const percent = value => `${Number(value || 0).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`;
  const compliance = Number(data.compliance || 0);
  const signal = compliance >= 100 ? 'green' : compliance >= 90 ? 'yellow' : 'red';
  const metrics = [
    ['Meta anual', money.format(data.annual_goal)],
    ['Forecast ponderado', money.format(data.weighted_forecast)],
    ['Venta real', money.format(data.actual_sales)],
    ['Cumplimiento', percent(compliance), signal],
    ['Gap vs meta', money.format(data.gap)],
    ['Pipeline total', money.format(data.pipeline_total)],
    ['Pipeline / Meta', percent(data.pipeline_to_goal)],
    ['Cuentas recuperadas', Number(data.recovered_accounts).toLocaleString('es-MX')],
    ['Clientes nuevos', Number(data.new_clients).toLocaleString('es-MX')]
  ];
  const series = [
    { key: 'goal', label: 'Meta de ventas', color: '#4f81bd' },
    { key: 'committed', label: 'Venta comprometida', color: '#c65353' },
    { key: 'probable', label: 'Venta probable', color: '#8ab65a' },
    { key: 'possible', label: 'Venta posible', color: '#8064a2' },
    { key: 'weighted_forecast', label: 'Forecast ponderado', color: '#43a7bd' }
  ];
  const width = 900, height = 390, left = 82, right = 24, top = 24, bottom = 66;
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const maximum = Math.max(1, ...data.months.flatMap(month => series.map(item => Number(month[item.key] || 0))));
  const x = index => left + index * chartWidth / 11;
  const y = value => top + chartHeight - Number(value || 0) / maximum * chartHeight;
  const compactMoney = new Intl.NumberFormat('es-MX', { notation: 'compact', maximumFractionDigits: 1 });
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = maximum * (4 - index) / 4;
    const gridY = y(value);
    return `<g><line x1="${left}" y1="${gridY}" x2="${width - right}" y2="${gridY}" class="dashboard-gridline"/><text x="${left - 10}" y="${gridY + 4}" text-anchor="end" class="dashboard-axis-label">${escapeHtml(compactMoney.format(value))}</text></g>`;
  }).join('');
  const monthLabels = data.months.map((month, index) => {
    const date = new Date(Date.UTC(data.year, month.month - 1, 1));
    const label = new Intl.DateTimeFormat('es-MX', { month: 'short', timeZone: 'UTC' }).format(date);
    return `<text x="${x(index)}" y="${height - 34}" text-anchor="middle" class="dashboard-axis-label">${escapeHtml(label)}</text>`;
  }).join('');
  const lines = series.map(item => {
    const points = data.months.map((month, index) => `${x(index)},${y(month[item.key])}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${data.months.map((month, index) => `<circle cx="${x(index)}" cy="${y(month[item.key])}" r="3.5" fill="${item.color}"><title>${escapeHtml(item.label)} ${index + 1}: ${escapeHtml(money.format(month[item.key]))}</title></circle>`).join('')}`;
  }).join('');
  const legend = series.map(item => `<span class="dashboard-legend-item"><i style="--series-color:${item.color}"></i>${item.label}</span>`).join('');
  document.querySelector('#dashboard-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Administración / Ventas</p><h1>Dashboard comercial</h1><p class="muted">Resumen anual y pronóstico de todos los vendedores.</p></div></div><div class="executive-dashboard"><section class="data-panel dashboard-metrics"><div class="panel-heading"><h2>Indicadores</h2><span>${data.year}</span></div><div class="dashboard-metric-table">${metrics.map(([label, value, tone]) => `<div class="dashboard-metric-row"><strong>${label}</strong><span>${value}</span>${tone ? `<b class="dashboard-signal dashboard-signal-${tone}">${tone === 'green' ? 'Verde' : tone === 'yellow' ? 'Amarillo' : 'Rojo'}</b>` : ''}</div>`).join('')}</div><form id="dashboard-goal-form" class="dashboard-goal-form"><label>Año<input name="year" id="dashboard-year" type="number" min="2000" max="2100" value="${data.year}" required></label><label>Meta anual (MXN)<input name="annual_goal" type="number" min="0" step="0.01" value="${Number(data.annual_goal).toFixed(2)}" required></label><button class="button button-primary" type="submit">Guardar meta</button><p id="dashboard-goal-message" class="field-help" aria-live="polite"></p></form><div class="dashboard-signal-key"><strong>Semáforo de cumplimiento</strong><span class="dashboard-signal-green">Verde · 100% o más</span><span class="dashboard-signal-yellow">Amarillo · 90–99%</span><span class="dashboard-signal-red">Rojo · menos de 90%</span></div></section><section class="data-panel dashboard-chart-panel"><div class="panel-heading"><div><h2>Meta vs Forecast ponderado</h2><span>Montos mensuales por fecha estimada de cierre · ${data.year}</span></div></div><div class="dashboard-chart-scroll"><svg class="dashboard-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfica mensual de meta, oportunidades comprometidas, probables, posibles y forecast ponderado">${grid}<line x1="${left}" y1="${top + chartHeight}" x2="${width - right}" y2="${top + chartHeight}" class="dashboard-axis"/><text x="19" y="${top + chartHeight / 2}" transform="rotate(-90 19 ${top + chartHeight / 2})" text-anchor="middle" class="dashboard-axis-label">Monto (MXN)</text>${lines}${monthLabels}<text x="${left + chartWidth / 2}" y="${height - 7}" text-anchor="middle" class="dashboard-axis-label">Mes</text></svg></div><div class="dashboard-chart-legend">${legend}</div><p class="dashboard-chart-note">Las oportunidades se clasifican por probabilidad: comprometida 70–100%, probable 40–69% y posible 0–39%. La meta anual se distribuye en partes iguales por mes.</p></section></div>`;
  document.querySelector('#dashboard-year').addEventListener('change', () => showDashboard().catch(error => alert(error.message)));
  document.querySelector('#dashboard-goal-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const message = document.querySelector('#dashboard-goal-message');
    try {
      await api('/api/admin/dashboard/goal', { method: 'PATCH', body: JSON.stringify({ year: Number(form.get('year')), annual_goal: Number(form.get('annual_goal')) }) });
      await showDashboard();
    } catch (error) { message.textContent = error.message; }
  });
  await showAnalysis(true);
}

// ---------- Ubicaciones ----------
function formatLocationStatus(location) {
  if (!location) return 'Todavía no hay una ubicación registrada.';
  return `Último registro ${escapeHtml(formatMovementTimestamp(location.updated_at))}${location.accuracy ? ` · precisión aproximada ${Math.round(location.accuracy)} m` : ''}`;
}

async function showLocations() {
  const historyQuery = new URLSearchParams({ page: String(locationHistoryPage) });
  if (locationHistoryFilters.sellerId) historyQuery.set('seller_id', locationHistoryFilters.sellerId);
  if (locationHistoryFilters.from) historyQuery.set('from', locationHistoryFilters.from);
  if (locationHistoryFilters.to) historyQuery.set('to', locationHistoryFilters.to);
  const [data, historyData] = await Promise.all([api('/api/location'), api(`/api/location/history?${historyQuery}`)]);
  const locations = data.locations || [];
  const records = historyData.records || [];
  const pageCount = Math.max(1, Math.ceil(historyData.total / historyData.page_size));
  const historyRows = records.map(record => `<tr><td>${escapeHtml(formatMovementTimestamp(record.recorded_at))}</td><td><strong>${escapeHtml(record.user_name)}</strong></td><td>${Number(record.latitude).toFixed(5)}, ${Number(record.longitude).toFixed(5)}<span class="table-subtext">Precisión aprox. ${record.accuracy ? `${Math.round(record.accuracy)} m` : 'no disponible'}</span></td><td><a class="map-link" href="https://www.google.com/maps?q=${record.latitude},${record.longitude}" target="_blank" rel="noreferrer">Abrir mapa</a></td></tr>`).join('');
  document.querySelector('#locations-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Administración / Personal en campo</p><h1>Ubicaciones de vendedores</h1><p class="muted">Última ubicación capturada al iniciar sesión y registro histórico.</p></div></div><section class="location-layout"><div id="location-map" class="location-map" aria-label="Mapa de vendedores"></div><section class="data-panel location-list"><h2>Última ubicación recibida</h2>${locations.map(location => `<article class="location-row"><div><strong>${escapeHtml(location.name)}</strong><span>${location.updated_at ? formatLocationStatus(location) : 'Sin ubicación registrada'}</span></div>${location.latitude !== null ? `<a class="map-link" href="https://www.google.com/maps?q=${location.latitude},${location.longitude}" target="_blank" rel="noreferrer">Abrir mapa</a>` : ''}</article>`).join('') || '<p class="empty-state">No hay vendedores activos.</p>'}</section></section><section class="data-panel location-history-panel"><div class="movement-panel-heading"><div><h2>Historial de ubicaciones</h2><span>${Number(historyData.total).toLocaleString('es-MX')} registros · 100 por página</span></div><div class="location-filters"><label>Vendedor<select id="location-seller-filter"><option value="">Todos</option>${locations.map(location => `<option value="${location.id}" ${String(location.id) === locationHistoryFilters.sellerId ? 'selected' : ''}>${escapeHtml(location.name)}</option>`).join('')}</select></label><label>Desde<input id="location-date-from" type="date" value="${escapeHtml(locationHistoryFilters.from)}"></label><label>Hasta<input id="location-date-to" type="date" value="${escapeHtml(locationHistoryFilters.to)}"></label><button class="button button-quiet" id="location-filter-clear" type="button">Limpiar</button><button class="button button-danger" id="location-history-delete" type="button" ${Number(historyData.total) ? '' : 'disabled'}>Eliminar historial</button></div></div><p class="field-help">Eliminar el historial no borra la última ubicación que aparece en el mapa.</p><div class="audit-table"><table><thead><tr><th>Fecha y hora</th><th>Vendedor</th><th>Coordenadas</th><th>Mapa</th></tr></thead><tbody>${historyRows}</tbody></table>${historyRows ? '' : '<p class="empty-state">No hay ubicaciones registradas con estos filtros.</p>'}</div><div class="location-pagination"><button class="button button-quiet" id="location-page-prev" type="button" ${locationHistoryPage <= 1 ? 'disabled' : ''}>Anterior</button><span>Página ${locationHistoryPage} de ${pageCount}</span><button class="button button-quiet" id="location-page-next" type="button" ${locationHistoryPage >= pageCount ? 'disabled' : ''}>Siguiente</button></div></section>`;
  if (locationMap) locationMap.remove();
  locationMarkers = [];
  const validLocations = locations.filter(location => location.latitude !== null && location.longitude !== null);
  if (window.L) {
    locationMap = L.map('location-map').setView(validLocations.length ? [validLocations[0].latitude, validLocations[0].longitude] : [23.6345, -102.5528], validLocations.length ? 12 : 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(locationMap);
    validLocations.forEach(location => {
      const marker = L.marker([location.latitude, location.longitude]).addTo(locationMap).bindPopup(`<strong>${escapeHtml(location.name)}</strong><br>${escapeHtml(formatLocationStatus(location))}`);
      locationMarkers.push(marker);
    });
  } else {
    document.querySelector('#location-map').textContent = 'No se pudo cargar el mapa. Revisa la conexión a Internet.';
  }
  document.querySelector('#location-seller-filter').addEventListener('change', event => { locationHistoryFilters.sellerId = event.target.value; locationHistoryPage = 1; showLocations().catch(error => alert(error.message)); });
  document.querySelector('#location-date-from').addEventListener('change', event => { locationHistoryFilters.from = event.target.value; locationHistoryPage = 1; showLocations().catch(error => alert(error.message)); });
  document.querySelector('#location-date-to').addEventListener('change', event => { locationHistoryFilters.to = event.target.value; locationHistoryPage = 1; showLocations().catch(error => alert(error.message)); });
  document.querySelector('#location-filter-clear').addEventListener('click', () => { locationHistoryFilters = { sellerId: '', from: '', to: '' }; locationHistoryPage = 1; showLocations().catch(error => alert(error.message)); });
  document.querySelector('#location-page-prev').addEventListener('click', () => { locationHistoryPage -= 1; showLocations().catch(error => alert(error.message)); });
  document.querySelector('#location-page-next').addEventListener('click', () => { locationHistoryPage += 1; showLocations().catch(error => alert(error.message)); });
  document.querySelector('#location-history-delete').addEventListener('click', async () => {
    if (!window.confirm('¿Eliminar todos los registros del historial de ubicaciones? La última ubicación de cada vendedor se conservará.')) return;
    try {
      await api('/api/admin/location/history', { method: 'DELETE' });
      locationHistoryPage = 1;
      await showLocations();
    } catch (error) { alert(error.message); }
  });
}

function captureLocationOnce() {
  if (currentUser?.role !== 'seller') return;
  const status = document.querySelector('#location-status');
  if (!navigator.geolocation) {
    status.textContent = 'Este dispositivo no permite obtener ubicación.';
    return;
  }
  if (!window.isSecureContext) {
    status.textContent = 'El navegador bloquea la ubicación en HTTP. Abre el CRM desde https:// o, en la laptop servidor, desde http://localhost:8000.';
    return;
  }
  status.textContent = 'Solicitando permiso para registrar la ubicación de esta sesión...';
  navigator.geolocation.getCurrentPosition(async position => {
    try {
      const result = await api('/api/location', { method: 'POST', body: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }) });
      status.textContent = result.recorded
        ? `Ubicación registrada · ${formatMovementTimestamp(result.updated_at)} · precisión aproximada ${Math.round(position.coords.accuracy)} m`
        : `La ubicación de esta sesión ya estaba registrada · ${formatMovementTimestamp(result.updated_at)}`;
      document.querySelector('#start-location').hidden = true;
    } catch (error) {
      status.textContent = error.message;
      document.querySelector('#start-location').hidden = false;
    }
  }, error => {
    status.textContent = `No se pudo obtener la ubicación: ${error.message}`;
    document.querySelector('#start-location').hidden = false;
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

// El panel de ubicación es solo para vendedores y solo aparece en la vista Clientes.
function applyRoleVisibility() {
  const isSeller = currentUser?.role === 'seller';
  document.querySelector('#seller-location-panel').hidden = !(isSeller && activeView === 'clients');
}

async function setupLocationPanel() {
  applyRoleVisibility();
  if (currentUser?.role !== 'seller' || locationPanelInitialized) return;
  locationPanelInitialized = true;
  document.querySelector('#start-location').addEventListener('click', captureLocationOnce);
  try {
    const data = await api('/api/location');
    if (data.recorded_this_session) {
      document.querySelector('#location-status').textContent = `Ubicación de esta sesión ya registrada${data.location ? ` · ${formatMovementTimestamp(data.location.updated_at)}` : ''}`;
      document.querySelector('#start-location').hidden = true;
      return;
    }
    if (data.location) document.querySelector('#location-status').textContent = formatLocationStatus(data.location);
  } catch (error) {
    document.querySelector('#location-status').textContent = `No se pudo consultar la última ubicación: ${error.message}`;
  }
  captureLocationOnce();
}

// ---------- Movimientos y auditoría ----------
async function showMovements() {
  const data = await api('/api/movements?' + rangeQuery(movementFilters));
  const movementRows = data.movements.map(row => `<tr><td>${escapeHtml(formatMovementTimestamp(row.created_at))}</td><td><strong>${escapeHtml(row.company)}</strong><span class="table-subtext">${escapeHtml(row.user_name)}</span></td><td>${row.from_stage ? `${stageLabel(row.from_stage)} → ` : ''}${stageLabel(row.to_stage)}</td><td>${row.call_date && row.call_time ? formatCall(row.call_date, row.call_time) : 'Sin llamada programada'}</td><td>${row.note ? escapeHtml(row.note) : '<span class="table-subtext">Sin nota</span>'}</td></tr>`).join('');
  const scopeLabel = currentUser.role === 'admin' ? 'Todos los vendedores' : 'Mis movimientos';
  document.querySelector('#movements-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Seguimiento / Actividad</p><h1>Movimientos</h1><p class="muted">Consulta los cambios de etapa, llamadas y resultados.</p></div><span class="date-label">${scopeLabel} · ${data.movements.length} registros</span></div><section class="data-panel movement-panel"><div class="movement-panel-heading"><h2>${scopeLabel}</h2><span>Máximo 200 registros</span>${rangeControls('mov', movementFilters)}</div>${movementRows ? `<div class="audit-table"><table><thead><tr><th>Fecha de registro</th><th>Prospecto / usuario</th><th>Movimiento</th><th>Llamada</th><th>Resultado / nota</th></tr></thead><tbody>${movementRows}</tbody></table></div>` : '<p class="empty-state">No hay movimientos registrados con estos filtros.</p>'}</section>`;
  bindRange('mov', movementFilters, showMovements);
}

async function showAudit() {
  const data = await api('/api/admin/audit?' + rangeQuery(auditFilters));
  document.querySelector('#audit-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Administración / Control</p><h1>Bitácora de auditoría</h1><p class="muted">Registro de cambios realizados en el sistema.</p></div></div>${rangeControls('aud', auditFilters)}<section class="data-panel audit-table"><table><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>${data.audit.map(row => `<tr><td>${escapeHtml(row.created_at)}</td><td>${escapeHtml(row.user_name)}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.detail)}</td></tr>`).join('')}</tbody></table></section>`;
  bindRange('aud', auditFilters, showAudit);
}

async function showUsers() {
  // Esta pantalla es exclusiva del administrador: alta, restablecimiento y baja lógica.
  const data = await api('/api/admin/users');
  document.querySelector('#users-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Administración / Equipo</p><h1>Usuarios</h1><p class="muted">Crea accesos, restablece contraseñas y desactiva vendedores.</p></div></div><div class="user-admin-grid"><section class="data-panel"><h2>Nuevo vendedor</h2><form id="new-user-form" class="admin-form"><label>Nombre completo<input name="name" required maxlength="80" placeholder="Ej. Luis Medina"></label><label>Usuario<input name="username" required maxlength="30" placeholder="luis.medina"></label><label>Contraseña inicial<input name="password" type="password" minlength="8" required placeholder="Mínimo 8 caracteres"></label><p id="user-form-message" class="form-error" hidden></p><button class="button button-primary" type="submit">Crear vendedor</button></form></section><section class="data-panel user-list"><h2>Accesos registrados</h2><div class="user-table">${data.users.map(item => `<div class="user-row ${item.active ? '' : 'user-inactive'}"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.username)} · ${item.role === 'admin' ? 'Administrador' : 'Vendedor'} · ${item.active ? 'Activo' : 'Desactivado'}</span></div>${item.role === 'seller' && item.active ? `<div class="user-actions"><button class="button button-quiet reset-user" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Restablecer</button><button class="button button-danger delete-user" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Eliminar</button></div>` : ''}</div>`).join('')}</div></section></div>`;
  document.querySelector('#new-user-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const message = document.querySelector('#user-form-message');
    try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ name: form.get('name'), username: form.get('username'), password: form.get('password') }) }); await showUsers(); } catch (error) { message.textContent = error.message; message.hidden = false; }
  });
  document.querySelectorAll('.reset-user').forEach(button => button.addEventListener('click', async () => {
    const newPassword = window.prompt(`Nueva contraseña para ${button.dataset.name} (mínimo 8 caracteres):`);
    if (!newPassword) return;
    try { await api(`/api/admin/users/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ new_password: newPassword }) }); window.alert('Contraseña actualizada.'); await showUsers(); } catch (error) { window.alert(error.message); }
  }));
  document.querySelectorAll('.delete-user').forEach(button => button.addEventListener('click', async () => {
    if (!window.confirm(`¿Desactivar a ${button.dataset.name}? Sus prospectos históricos se conservarán, pero ya no podrá iniciar sesión.`)) return;
    try { await api(`/api/admin/users/${button.dataset.id}`, { method: 'DELETE' }); await showUsers(); } catch (error) { window.alert(error.message); }
  }));
}

// ---------- Navegación ----------
async function showView(view) {
  if (view === 'analysis') view = 'dashboard';
  if (view === activeView) return;
  activeView = view;
  document.querySelectorAll('[data-page]').forEach(element => { element.hidden = element.dataset.page !== view; });
  applyRoleVisibility(); // oculta el panel de ubicación al admin y fuera de Clientes
  document.querySelectorAll('[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === view));
  if (view === 'clients' || view === 'today') await loadClients(); // datos frescos; en "today" también dibuja la vista
  if (view === 'dashboard') await showDashboard();
  if (view === 'appointments') await showAppointments();
  if (view === 'kpis') await showKpis();
  if (view === 'locations') await showLocations();
  if (view === 'movements') await showMovements();
  if (view === 'audit') await showAudit();
  if (view === 'users') await showUsers();
}

// La navegación se maneja sin recargar la página para conservar una experiencia
// rápida incluso cuando la laptop funciona como servidor.
document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', async event => { event.preventDefault(); await showView(link.dataset.view); }));
document.querySelector('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});
document.querySelector('#account-button').addEventListener('click', () => { document.querySelector('#password-message').hidden = true; document.querySelector('#password-form').reset(); document.querySelector('#account-dialog').showModal(); });
document.querySelector('#close-account').addEventListener('click', () => document.querySelector('#account-dialog').close());
document.querySelector('#cancel-account').addEventListener('click', () => document.querySelector('#account-dialog').close());
document.querySelector('#password-form').addEventListener('submit', async event => { event.preventDefault(); const form = new FormData(event.target); const message = document.querySelector('#password-message'); try { await api('/api/account/password', { method: 'PATCH', body: JSON.stringify({ current_password: form.get('current_password'), new_password: form.get('new_password') }) }); document.querySelector('#account-dialog').close(); event.target.reset(); window.alert('Contraseña actualizada correctamente.'); } catch (error) { message.textContent = error.message; message.hidden = false; } });

// ---------- Sesión ----------
// El login decide la vista y los permisos visibles, pero la seguridad real
// siempre se valida otra vez en las rutas del servidor.
async function startSession(user) {
  currentUser = user;
  document.querySelector('#login-screen').hidden = true;
  document.querySelector('#app-shell').hidden = false;
  document.querySelector('#user-name').textContent = user.name;
  document.querySelector('#user-role').textContent = user.role === 'admin' ? 'Administrador' : 'Vendedor(a)';
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = user.role !== 'admin'; });
  await loadClients();
  await setupLocationPanel();
  announceFollowUps();
  setInterval(checkReminders, 60000);
  checkReminders();
  await showView(user.role === 'admin' ? 'dashboard' : 'clients');
}

document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const error = document.querySelector('#login-error');
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
    await startSession(result.user);
  } catch (loginError) { error.textContent = loginError.message; error.hidden = false; }
});

// Si ya existe una sesión válida, el usuario entra directo al CRM después de
// recargar; si no, el formulario de acceso permanece visible.
(async function boot() {
  try { const session = await api('/api/session'); if (session.user) await startSession(session.user); }
  catch { /* El formulario de acceso queda disponible. */ }
}());