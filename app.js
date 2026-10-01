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
let activeView = 'clients';
let clientLayout = 'pipeline';
let locationWatchId = null;
let locationRefreshTimer = null;
let locationEventPollTimer = null;
let locationEventCursor = null;
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
  const payload = await response.json();
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

async function pollLocationStopEvents() {
  const path = locationEventCursor === null
    ? '/api/admin/location-events'
    : `/api/admin/location-events?after=${locationEventCursor}`;
  const data = await api(path);
  locationEventCursor = data.cursor;
  data.events.forEach(event => {
    const message = `${event.user_name} detuvo el uso compartido de su ubicación.`;
    showToast(message, () => showView('locations').catch(error => alert(error.message)));
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Grubox CRM', { body: message });
    }
  });
}

function startLocationEventPolling() {
  if (currentUser?.role !== 'admin' || locationEventPollTimer !== null) return;
  pollLocationStopEvents().catch(() => {});
  locationEventPollTimer = setInterval(() => pollLocationStopEvents().catch(() => {}), 15000);
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
    pipeline.innerHTML = `<div class="audit-table"><table><thead><tr><th>Prospecto</th><th>Planta</th><th>Código MP</th><th>OC</th><th>Piezas / Kg</th><th>UM</th><th>Requerimiento planeado</th><th>Fecha de entrega</th><th>Proveedor</th><th>Etapa</th><th>Acciones</th></tr></thead><tbody>${visible.map(client => `<tr><td><strong>${escapeHtml(client.company)}</strong><span class="table-subtext">${escapeHtml(client.contact)} · ${escapeHtml(client.owner_name || '')}</span></td><td>${escapeHtml(client.plant || '')}</td><td>${escapeHtml(client.material_code || '')}</td><td>${escapeHtml(client.purchase_order || '')}</td><td>${client.pieces_per_kg == null ? '' : escapeHtml(Number(client.pieces_per_kg).toLocaleString('es-MX'))}</td><td>${escapeHtml(client.unit_of_measure || '')}</td><td>${escapeHtml(client.planned_requirement || '')}</td><td>${client.expected_delivery_date || client.requested_delivery_date ? escapeHtml(formatCalendarDate(client.expected_delivery_date || client.requested_delivery_date)) : ''}</td><td>${escapeHtml(client.supplier || '')}</td><td>${escapeHtml(stageLabel(client.stage))}</td><td><div class="list-actions"><button class="button button-quiet follow-up-button" data-id="${client.id}" type="button" aria-label="Seguimiento de ${escapeHtml(client.company)}">◷</button><button class="button button-quiet edit-button" data-id="${client.id}" type="button">Editar</button></div></td></tr>`).join('') || '<tr><td colspan="11">Sin registros</td></tr>'}</tbody></table></div>`;
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
  const contactLabels = { call: 'Llamada', whatsapp: 'WhatsApp', email: 'Correo electrónico', visit: 'Visita' };
  const prospectDetails = [
    client.internal_code ? `Código: ${client.internal_code}` : '',
    client.preferred_contact ? `Contacto: ${contactLabels[client.preferred_contact] || client.preferred_contact}` : '',
    client.sample_provided === null || client.sample_provided === undefined ? '' : `Muestra: ${Number(client.sample_provided) ? 'Recibida' : 'No recibida'}`,
    client.drawing_provided === null || client.drawing_provided === undefined ? '' : `Plano: ${Number(client.drawing_provided) ? 'Recibido' : 'No recibido'}`,
    client.requested_delivery_date ? `Entrega solicitada: ${formatCalendarDate(client.requested_delivery_date)}` : '',
    client.expected_delivery_date ? `Entrega prevista: ${formatCalendarDate(client.expected_delivery_date)}` : ''
  ].filter(Boolean).map(escapeHtml).join(' · ');
  const status = followUpStatus(client);
  const idle = isOpen(client) ? daysSinceMovement(client) : null;
  const badges = [
    status === 'overdue' ? '<span class="badge badge-overdue">Vencido</span>' : '',
    status === 'today' ? '<span class="badge badge-today">Hoy</span>' : '',
    status === 'unscheduled' ? '<span class="badge badge-warn">Sin seguimiento</span>' : '',
    idle !== null && idle >= STALE_DAYS ? `<span class="badge badge-idle">${idle} d sin actividad</span>` : ''
  ].join('');
  const deleteButton = currentUser?.role === 'admin' ? `<button class="delete-client" data-id="${client.id}" data-company="${escapeHtml(client.company)}" type="button">Eliminar prospecto</button>` : '';
  const shownValue = client.stage === 'won' && client.won_value !== null && client.won_value !== undefined ? client.won_value : client.value;
  return `<div class="client-card" data-stage="${client.stage}" data-follow="${status}" data-id="${client.id}" draggable="true">
    <h3>${escapeHtml(client.company)}</h3>
    ${badges ? `<div class="badge-row">${badges}</div>` : ''}
    <p>${escapeHtml(client.contact)}</p>
    ${contactData ? `<p class="contact-data">${contactData}</p>` : ''}
    ${prospectDetails ? `<p class="prospect-details">${prospectDetails}</p>` : ''}
    <p class="box-type">${escapeHtml(client.box_type || 'Tipo de caja pendiente')}</p>
    <p class="client-value">${money.format(shownValue)}</p>
    <p class="quantity-info">Cantidad estimada: ${Number(client.estimated_quantity || 0).toLocaleString('es-MX')}</p>
    <p class="next-action">${escapeHtml(client.next_action)}</p>
    ${client.pinned_note ? `<p class="pinned-note">📌 ${escapeHtml(client.pinned_note)}</p>` : ''}${client.stage === 'lost' && client.lost_reason ? `<p class="lost-reason">Motivo: ${escapeHtml(client.lost_reason)}</p>` : ''}
    <div class="card-record">
      <p class="call-info">${escapeHtml(call)}</p>
      <p class="movement-info"><strong>Último movimiento:</strong> ${escapeHtml(movement)}${client.last_movement_at ? ` · ${escapeHtml(formatMovementTimestamp(client.last_movement_at))}` : ''}</p>
      ${client.last_note ? `<p class="movement-note">${escapeHtml(client.last_note)}</p>` : ''}
    </div>
    ${isOpen(client) ? `<div class="contact-actions">${contactActions(client)}</div>` : ''}
    <div class="card-actions">
      <button class="button button-quiet follow-up-button" data-id="${client.id}" type="button"><span aria-hidden="true">◷</span> Seguimiento</button>
      <button class="button button-quiet edit-button" data-id="${client.id}" type="button">✎ Editar</button>
      <label><span class="sr-only">Cambiar etapa</span><select class="move-select" data-id="${client.id}" aria-label="Cambiar etapa de ${escapeHtml(client.company)}">${stages.map(stage => `<option value="${stage.id}" ${stage.id === client.stage ? 'selected' : ''}>Mover a ${stage.label}</option>`).join('')}</select></label>
    </div>
    ${deleteButton}
  </div>`;
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

async function showAnalysis() {
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
  document.querySelector('#analysis-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Rendimiento / Decisiones comerciales</p><h1>Análisis de seguimiento</h1><p class="muted">Citas, resultados y cambios de etapa · ${scope}</p></div>${rangeControls('analysis', analysisFilters)}</div><section class="analysis-metrics">${metrics.map(metric => `<article class="analysis-metric ${metric.tone ? `analysis-${metric.tone}` : ''}"><span>${metric.label}</span><strong>${metric.value}</strong><small>${metric.detail}</small></article>`).join('')}</section><div class="analysis-chart-grid"><section class="data-panel analysis-activity-chart"><div class="panel-heading"><div><h2>Actividad en el periodo</h2><span>Registro de citas por fecha</span></div><div class="analysis-chart-legend"><span><i class="legend-scheduled"></i>Agendadas</span><span><i class="legend-completed"></i>Realizadas</span><span><i class="legend-rescheduled"></i>Reprogramadas</span><span><i class="legend-canceled"></i>Canceladas</span></div></div>${data.events.length ? `<div class="analysis-bar-chart" role="img" aria-label="Actividad de citas agrupada en ocho intervalos del periodo">${activityBars}</div>` : '<p class="empty-state">No hay actividad de citas en este periodo.</p>'}</section><section class="data-panel analysis-outcome-chart"><div class="panel-heading"><div><h2>Resultado de citas</h2><span>Distribución del periodo</span></div></div><div class="analysis-outcome-layout"><div class="analysis-donut" role="img" aria-label="${resultTotal} citas consideradas" style="--donut-chart:${resultGradient}"><div><strong>${resultTotal}</strong><span>citas</span></div></div><div class="analysis-outcome-legend">${resultLegend}</div></div></section></div><div class="analysis-grid"><section class="data-panel analysis-pipeline"><div class="panel-heading"><div><h2>Pipeline actual</h2><span>Oportunidades y valor por etapa</span></div></div>${stageRows}</section><section class="data-panel analysis-insight"><p class="eyebrow">Lectura del periodo</p><h2>${advanceNarrative}</h2><p>${completed ? `${completed} de ${Number(summary.scheduled || 0)} citas programadas terminaron realizadas. ${Number(summary.stayed || 0)} oportunidad(es) continuaron en la misma etapa.` : 'Registra el resultado de las reuniones para identificar qué oportunidades avanzan.'}</p><button class="button button-quiet" id="analysis-open-appointments" type="button">Ver agenda de citas</button></section></div><details class="data-panel analysis-events"><summary><span><strong>Historial detallado</strong><small>${data.events.length} eventos · máximo 300 por consulta</small></span><span class="analysis-details-icon" aria-hidden="true">⌄</span></summary><div class="audit-table"><table><thead><tr><th>Registrado</th><th>Fecha de cita</th><th>Prospecto / ejecutivo</th><th>Resultado</th><th>Etapa</th><th>Acuerdos y próxima acción</th></tr></thead><tbody>${eventRows}</tbody></table>${eventRows ? '' : '<p class="empty-state">No hay citas ni resultados en este periodo.</p>'}</div></details>`;
  bindRange('analysis', analysisFilters, showAnalysis);
  document.querySelector('#analysis-open-appointments').addEventListener('click', () => showView('appointments'));
  const analysisStagesTitle = document.querySelector('#analysis-page .analysis-pipeline h2');
  if (analysisStagesTitle) analysisStagesTitle.textContent = 'Oportunidades por etapa';
  if (currentUser.role === 'admin') await showDashboard();
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
  const cols = [['company', 'Empresa'], ['contact', 'Contacto'], ['internal_code', 'Código'], ['plant', 'Planta'], ['material_code', 'Código MP'], ['purchase_order', 'OC'], ['pieces_per_kg', 'Piezas / Kg'], ['unit_of_measure', 'UM'], ['planned_requirement', 'Requerimiento planeado'], ['expected_delivery_date', 'Fecha de entrega'], ['supplier', 'Proveedor'], ['contact_phone', 'Teléfono'], ['email', 'Correo'], ['box_type', 'Tipo de caja'], ['estimated_quantity', 'Cantidad'], ['value', 'Valor estimado'], ['won_value', 'Importe vendido'], ['stage', 'Etapa'], ['lost_reason', 'Motivo de pérdida'], ['owner_name', 'Vendedor'], ['call_date', 'Próximo contacto'], ['next_action', 'Próxima acción']];
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`; // evita fórmulas en Excel
    return `"${text.replace(/"/g, '""')}"`;
  };
  const { items } = await fetchClientPages(true);
  const rows = items.map(c => cols.map(([key]) => cell(key === 'stage' ? stageLabel(c.stage) : c[key])).join(','));
  const csv = '\ufeff' + [cols.map(([, label]) => cell(label)).join(','), ...rows].join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `prospectos-${todayIso()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Alta de prospectos: el navegador solo recoge el formulario; la validación y
// la escritura definitiva ocurren en el servidor.
document.querySelector('#client-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  try { await api('/api/clients', { method: 'POST', body: JSON.stringify({ company: form.get('company'), contact: form.get('contact'), contact_phone: form.get('contactPhone'), email: form.get('email'), company_phone: form.get('companyPhone'), value: Number(form.get('value')), estimated_quantity: Number(form.get('estimatedQuantity')), box_type: form.get('boxType'), next_action: form.get('nextAction'), stage: form.get('stage'), won_value: form.get('wonValue') === '' ? undefined : Number(form.get('wonValue')), call_date: form.get('callDate'), call_time: form.get('callTime'), internal_code: form.get('internalCode'), sample_provided: Number(form.get('sampleProvided')), preferred_contact: form.get('preferredContact'), drawing_provided: Number(form.get('drawingProvided')), requested_delivery_date: form.get('requestedDeliveryDate'), expected_delivery_date: form.get('expectedDeliveryDate'), plant: form.get('plant'), material_code: form.get('materialCode'), purchase_order: form.get('purchaseOrder'), pieces_per_kg: form.get('piecesPerKg') === '' ? null : Number(form.get('piecesPerKg')), unit_of_measure: form.get('unitOfMeasure'), planned_requirement: form.get('plannedRequirement'), supplier: form.get('supplier') }) }); event.target.reset(); document.querySelector('#new-won-value-field').hidden = true; document.querySelector('#client-form').elements.wonValue.required = false; document.querySelector('#client-dialog').close(); await loadClients(); } catch (error) { alert(error.message); }
});
document.querySelector('#client-stage').addEventListener('change', event => {
  const isWon = event.target.value === 'won';
  document.querySelector('#new-won-value-field').hidden = !isWon;
  document.querySelector('#client-form').elements.wonValue.required = isWon;
});
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
    if (activeView === 'analysis') await showAnalysis();
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
document.querySelector('#new-client').addEventListener('click', () => document.querySelector('#client-dialog').showModal());
document.querySelector('#close-dialog').addEventListener('click', () => { document.querySelector('#client-form').reset(); document.querySelector('#new-won-value-field').hidden = true; document.querySelector('#client-form').elements.wonValue.required = false; document.querySelector('#client-dialog').close(); });
document.querySelector('#cancel-dialog').addEventListener('click', () => { document.querySelector('#client-form').reset(); document.querySelector('#new-won-value-field').hidden = true; document.querySelector('#client-form').elements.wonValue.required = false; document.querySelector('#client-dialog').close(); });
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
  if (!card) return;
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
  ['company', 'contact', 'contact_phone', 'email', 'company_phone', 'internal_code', 'value', 'estimated_quantity', 'box_type', 'preferred_contact', 'requested_delivery_date', 'expected_delivery_date', 'pinned_note', 'plant', 'material_code', 'purchase_order', 'pieces_per_kg', 'unit_of_measure', 'planned_requirement', 'supplier']
    .forEach(name => { form.elements[name].value = client[name] ?? ''; });
  form.elements.sample_provided.value = Number(client.sample_provided || 0);
  form.elements.drawing_provided.value = Number(client.drawing_provided || 0);
  if (currentUser.role === 'admin') {
    const { users } = await api('/api/admin/users');
    document.querySelector('#edit-owner').innerHTML = users.filter(user => user.role === 'seller' && user.active)
      .map(user => `<option value="${user.id}" ${user.id === client.owner_id ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('');
  }
  document.querySelector('#edit-dialog').showModal();
}
pipeline.addEventListener('click', event => {
  const button = event.target.closest('.edit-button');
  if (button) openEditDialog(button.dataset.id).catch(error => alert(error.message));
});
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
  const data = await api('/api/admin/summary');
  const stageData = stages.map(stage => ({ ...stage, count: data.stages.find(item => item.stage === stage.id)?.count || 0 }));
  const maxStageCount = Math.max(...stageData.map(item => item.count), 1);
  const callLabels = { overdue: 'Vencidas', today: 'Hoy', soon: 'Próximas', later: 'Después' };
  const callStats = Object.fromEntries((data.call_stats || []).map(item => [item.status, item.count]));
  const notifications = data.notifications || [];
  const maxLost = Math.max(...(data.lost_reasons || []).map(item => Number(item.amount)), 1);
  const sellerFollowHtml = `<section class="data-panel seller-follow-panel"><div class="panel-heading"><h2>Seguimiento por vendedor</h2><span>Estado actual</span></div><div class="audit-table"><table><thead><tr><th>Vendedor</th><th>Vencidos</th><th>Hoy</th><th>Sin fecha</th><th>Seguimientos (semana)</th></tr></thead><tbody>${(data.seller_follow || []).map(seller => `<tr><td><strong>${escapeHtml(seller.name)}</strong></td><td class="${seller.overdue ? 'text-overdue' : ''}">${seller.overdue}</td><td>${seller.today}</td><td>${seller.unscheduled}</td><td>${seller.follow_ups_week}</td></tr>`).join('') || '<tr><td colspan="5">No hay vendedores activos.</td></tr>'}</tbody></table></div></section>`;
  const lostHtml = `<section class="data-panel chart-panel"><div class="panel-heading"><h2>Motivos de pérdida</h2><span>Dinero perdido</span></div>${(data.lost_reasons || []).map(item => `<div class="chart-row"><span>${escapeHtml(item.reason)}</span><div class="chart-track"><i style="width:${Number(item.amount) / maxLost * 100}%"></i></div><strong>${item.count} · ${money.format(item.amount)}</strong></div>`).join('') || '<p class="empty-state">Aún no hay oportunidades perdidas.</p>'}</section>`;
  document.querySelector('#dashboard-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Administración / Rendimiento</p><h1>Panel gerencial</h1><p class="muted">Una lectura rápida de la operación comercial.</p></div><span class="date-label">Todos los vendedores</span></div><section class="summary"><div><span>Oportunidades</span><strong>${data.totals.total}</strong></div><div><span>Dinero ganado</span><strong>${money.format(data.totals.won_value)}</strong></div><div><span>Dinero en pipeline</span><strong>${money.format(data.totals.active_value)}</strong></div><div><span>Dinero perdido</span><strong>${money.format(data.totals.lost_value)}</strong></div></section><div class="dashboard-grid"><section class="data-panel chart-panel"><div class="panel-heading"><h2>Prospectos por etapa</h2><span>Volumen</span></div>${stageData.map(item => `<div class="chart-row"><span>${item.label}</span><div class="chart-track"><i style="width:${item.count / maxStageCount * 100}%"></i></div><strong>${item.count}</strong></div>`).join('')}</section><section class="data-panel chart-panel"><div class="panel-heading"><h2>Ventas por vendedor</h2><span>Dinero ganado</span></div>${data.sellers.map(seller => `<div class="chart-row"><span>${escapeHtml(seller.name)}</span><div class="chart-track"><i style="width:${data.totals.won_value ? Math.min(100, seller.won_value / data.totals.won_value * 100) : 0}%"></i></div><strong>${money.format(seller.won_value)}</strong></div>`).join('') || '<p class="empty-state">No hay vendedores activos.</p>'}</section><section class="data-panel chart-panel"><div class="panel-heading"><h2>Seguimientos pendientes</h2><span>Prospectos activos</span></div>${Object.keys(callLabels).map(status => `<div class="chart-row"><span>${callLabels[status]}</span><div class="chart-track"><i class="chart-${status}" style="width:${callStats[status] ? Math.max(8, callStats[status] / Math.max(...Object.values(callStats), 1) * 100) : 0}%"></i></div><strong>${callStats[status] || 0}</strong></div>`).join('')}</section><section class="data-panel notification-panel"><div class="panel-heading"><h2>Notificaciones</h2><span>${notifications.length ? `${notifications.length} pendientes` : 'Todo al día'}</span></div>${notifications.length ? `<div class="notification-list">${notifications.map(item => `<button class="notification-item notification-${item.priority}" type="button" data-client-id="${item.id}"><span class="notification-icon" aria-hidden="true">!</span><span><strong>${escapeHtml(item.company)}</strong><small>${item.priority === 'overdue' ? 'Seguimiento vencido' : item.priority === 'today' ? 'Seguimiento para hoy' : 'Seguimiento próximo'} · ${escapeHtml(item.owner_name)}${item.call_time ? ` · ${escapeHtml(item.call_time)}` : ''}</small></span><span aria-hidden="true">→</span></button>`).join('')}</div>` : '<p class="empty-state">No hay seguimientos vencidos ni próximos.</p>'}</section>${sellerFollowHtml}${lostHtml}</div>`;
  document.querySelector('#dashboard-page h1').textContent = 'Resumen gerencial';
  document.querySelectorAll('#dashboard-page .summary span')[2].textContent = 'Dinero en oportunidades activas';
  document.querySelectorAll('.notification-item').forEach(button => button.addEventListener('click', () => openFollowUp(button.dataset.clientId).catch(error => alert(error.message))));
}

// ---------- Ubicaciones ----------
function formatLocationStatus(location) {
  if (!location) return 'Todavía no hay una ubicación registrada.';
  const state = Number(location.sharing) ? 'Compartiendo' : 'Detenida';
  return `${state} · última señal ${escapeHtml(formatMovementTimestamp(location.updated_at))}${location.accuracy ? ` · precisión aproximada ${Math.round(location.accuracy)} m` : ''}`;
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
  document.querySelector('#locations-page').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Administración / Personal en campo</p><h1>Ubicaciones de vendedores</h1><p class="muted">Última señal por vendedor y registro histórico de cada ubicación compartida.</p></div><span class="date-label">Estado actual · actualización cada 30 segundos</span></div><section class="location-layout"><div id="location-map" class="location-map" aria-label="Mapa de vendedores"></div><section class="data-panel location-list"><h2>Última ubicación recibida</h2>${locations.map(location => `<article class="location-row"><div><strong>${escapeHtml(location.name)}</strong><span>${location.updated_at ? formatLocationStatus(location) : 'Sin ubicación registrada'}</span></div>${location.latitude !== null ? `<a class="map-link" href="https://www.google.com/maps?q=${location.latitude},${location.longitude}" target="_blank" rel="noreferrer">Abrir mapa</a>` : ''}</article>`).join('') || '<p class="empty-state">No hay vendedores activos.</p>'}</section></section><section class="data-panel location-history-panel"><div class="movement-panel-heading"><div><h2>Historial de ubicaciones</h2><span>${Number(historyData.total).toLocaleString('es-MX')} registros · 100 por página</span></div><div class="location-filters"><label>Vendedor<select id="location-seller-filter"><option value="">Todos</option>${locations.map(location => `<option value="${location.id}" ${String(location.id) === locationHistoryFilters.sellerId ? 'selected' : ''}>${escapeHtml(location.name)}</option>`).join('')}</select></label><label>Desde<input id="location-date-from" type="date" value="${escapeHtml(locationHistoryFilters.from)}"></label><label>Hasta<input id="location-date-to" type="date" value="${escapeHtml(locationHistoryFilters.to)}"></label><button class="button button-quiet" id="location-filter-clear" type="button">Limpiar</button></div></div><div class="audit-table"><table><thead><tr><th>Fecha y hora</th><th>Vendedor</th><th>Coordenadas</th><th>Mapa</th></tr></thead><tbody>${historyRows}</tbody></table>${historyRows ? '' : '<p class="empty-state">No hay ubicaciones registradas con estos filtros.</p>'}</div><div class="location-pagination"><button class="button button-quiet" id="location-page-prev" type="button" ${locationHistoryPage <= 1 ? 'disabled' : ''}>Anterior</button><span>Página ${locationHistoryPage} de ${pageCount}</span><button class="button button-quiet" id="location-page-next" type="button" ${locationHistoryPage >= pageCount ? 'disabled' : ''}>Siguiente</button></div></section>`;
  if (locationMap) locationMap.remove();
  locationMarkers = [];
  const validLocations = locations.filter(location => location.latitude !== null && location.longitude !== null && Number(location.sharing));
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
  if (locationRefreshTimer) clearTimeout(locationRefreshTimer);
  locationRefreshTimer = setTimeout(() => { if (!document.querySelector('#locations-page').hidden) showLocations().catch(() => {}); }, 30000);
}

function setLocationStatus(message, active = false) {
  document.querySelector('#location-status').textContent = message;
  document.querySelector('#start-location').hidden = active;
  document.querySelector('#stop-location').hidden = !active;
}

async function sendLocation(position) {
  const result = await api('/api/location', { method: 'POST', body: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }) });
  setLocationStatus(`Compartiendo · última señal ${formatMovementTimestamp(result.updated_at)} · precisión aproximada ${Math.round(position.coords.accuracy)} m`, true);
}

function startLocationSharing() {
  if (currentUser?.role !== 'seller') return; // el admin nunca comparte ubicación
  if (!navigator.geolocation) return setLocationStatus('Este dispositivo no permite obtener ubicación.');
  if (!window.isSecureContext) return setLocationStatus('El navegador bloquea la ubicación en HTTP. Abre el CRM desde https:// o, en la laptop servidor, desde http://localhost:8000.');
  if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId);
  setLocationStatus('Solicitando permiso de ubicación...');
  locationWatchId = navigator.geolocation.watchPosition(position => sendLocation(position).catch(error => setLocationStatus(error.message)), error => setLocationStatus(`No se pudo obtener la ubicación: ${error.message}`), { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
}

async function stopLocationSharing() {
  if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId);
  locationWatchId = null;
  await api('/api/location/stop', { method: 'POST' });
  setLocationStatus('La ubicación dejó de compartirse.');
}

// El panel de ubicación es solo para vendedores y solo aparece en la vista Clientes.
function applyRoleVisibility() {
  const isSeller = currentUser?.role === 'seller';
  document.querySelector('#seller-location-panel').hidden = !(isSeller && activeView === 'clients');
}

async function setupLocationPanel() {
  applyRoleVisibility();
  if (currentUser?.role !== 'seller') return;
  document.querySelector('#start-location').addEventListener('click', startLocationSharing);
  document.querySelector('#stop-location').addEventListener('click', () => stopLocationSharing().catch(error => setLocationStatus(error.message)));
  const data = await api('/api/location');
  if (data.location?.sharing) setLocationStatus(formatLocationStatus(data.location), true);
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
  if (view === activeView) return;
  activeView = view;
  document.querySelectorAll('[data-page]').forEach(element => { element.hidden = element.dataset.page !== view || (element.id === 'dashboard-page' && currentUser?.role !== 'admin'); });
  applyRoleVisibility(); // oculta el panel de ubicación al admin y fuera de Clientes
  document.querySelectorAll('[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === view));
  if (view === 'clients' || view === 'today') await loadClients(); // datos frescos; en "today" también dibuja la vista
  if (view === 'appointments') await showAppointments();
  if (view === 'analysis') await showAnalysis();
  if (view === 'kpis') await showKpis();
  if (view === 'locations') await showLocations();
  if (view === 'movements') await showMovements();
  if (view === 'audit') await showAudit();
  if (view === 'users') await showUsers();
}

// La navegación se maneja sin recargar la página para conservar una experiencia
// rápida incluso cuando la laptop funciona como servidor.
document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', async event => { event.preventDefault(); await showView(link.dataset.view); }));
document.querySelector('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });
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
  document.querySelector('#user-role').textContent = user.role === 'admin' ? 'Administrador' : 'Vendedora';
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = user.role !== 'admin'; });
  await loadClients();
  await setupLocationPanel();
  startLocationEventPolling();
  announceFollowUps();
  setInterval(checkReminders, 60000);
  checkReminders();
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