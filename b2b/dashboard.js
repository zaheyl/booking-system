// dashboard.js (B2B dashboard)
// Every number, row and calendar cell on this page comes from the
// same bookings the B2C site creates.

const API_URL = 'http://booking-system-production-fa13.up.railway.app;

const token = sessionStorage.getItem('token');
const company = JSON.parse(sessionStorage.getItem('company') || 'null');

// no token means no session — nothing on this page should load
if (!token || !company) {
  window.location.replace('login.html');
}

// Every authenticated request goes through here, so the token is
// attached in exactly one place and a dead session always lands the
// user back on the login page instead of showing an empty dashboard.
async function api(path, options = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };

  // let the browser set its own multipart boundary for uploads
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (response.status === 401) {
    signOut('Your session ended. Please log in again.');
    throw new Error('Unauthorised');
  }

  return response;
}

function signOut(message) {
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('company');
  window.location.replace('login.html' + (message ? '?msg=' + encodeURIComponent(message) : ''));
}

let allBookings = [];
let allProducts = [];
let allSections = [];
let schedulingMode = company ? (company.scheduling_mode || 'day') : 'day';
let weekDate = new Date();
let pendingUploadSectionId = null;
let calDate = new Date();

// a tour company charges per day, a homestay per night — this changes
// the wording, the totals and which calendar days count as booked
let pricingMode = company ? (company.pricing_mode || 'per_day') : 'per_day';
let currency = company ? (company.currency || '$') : '$';

// products the user uploaded but hasn't saved yet
let drafts = [];
let draftId = 0;
// existing products whose title/price/hours were edited
let editedProducts = {};

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dateRangeText(booking) {
  return booking.start_date === booking.end_date
    ? formatDate(booking.start_date)
    : `${formatDate(booking.start_date)} \u2013 ${formatDate(booking.end_date)}`;
}

function countDays(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.round((b - a) / 86400000) + 1;
}

function money(value) {
  const amount = Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'RM' ? `RM ${amount}` : `${currency}${amount}`;
}

// "3 nights" for a homestay, "3 days" for a tour
function durationText(booking) {
  const days = countDays(booking.start_date, booking.end_date);
  const count = pricingMode === 'per_night' ? days - 1 : days;
  const unit = pricingMode === 'per_night' ? 'night' : 'day';
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function getImageUrl(image) {
  const url = typeof image === 'string' ? image : (image && image.url);
  if (!url) return 'https://via.placeholder.com/240x180?text=No+Image';
  if (url.startsWith('http')) return url;
  return API_URL + url;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// sets a button's content to a spinning icon + label, e.g. while an
// async request is in flight. Pair with plain btn.textContent = '...'
// to restore it afterwards.
function setButtonLoading(btn, label) {
  btn.innerHTML = `<span class="btn-spinner"></span>${escapeHtml(label)}`;
}

// ------------------------------------------------------------
// product colours — every product keeps the same colour everywhere
// (tags, sub-banners, cancel modal, calendar bars)
// ------------------------------------------------------------
const PRODUCT_PALETTE = [
  { bg: '#FDECC8', text: '#8A5A00', solid: '#E7A33E' }, // amber
  { bg: '#DCEEFB', text: '#155D8B', solid: '#2E86C1' }, // sky
  { bg: '#E4F3EC', text: '#1F7A52', solid: '#2E9E6D' }, // green
  { bg: '#F3E4F5', text: '#7A3E86', solid: '#9B5DA8' }, // purple
  { bg: '#FAE7E5', text: '#A33531', solid: '#C0433F' }, // red
  { bg: '#E7E9F5', text: '#2C3E8B', solid: '#3F52B8' }, // indigo
  { bg: '#FDE8F0', text: '#A32463', solid: '#D6408A' }, // pink
  { bg: '#E9F5E1', text: '#4C7A1F', solid: '#6FA82E' }, // lime
  { bg: '#FFF1DE', text: '#96591A', solid: '#D98A32' }, // orange
  { bg: '#E3F6F5', text: '#137A76', solid: '#1FA8A2' }  // teal
];

let productColorMap = {};   // product id -> palette entry
let productRowMap = {};     // product id -> fixed calendar row index

function buildProductColorMap() {
  productColorMap = {};
  productRowMap = {};
  const sorted = [...allProducts].sort((a, b) => a.id - b.id);
  sorted.forEach((product, i) => {
    const chosen = product.color_index;
    const idx = (chosen !== null && chosen !== undefined && chosen !== '')
      ? Number(chosen) % PRODUCT_PALETTE.length
      : i % PRODUCT_PALETTE.length;
    productColorMap[product.id] = PRODUCT_PALETTE[idx];
    productRowMap[product.id] = i;
  });
}

function colorForProductId(id) {
  return productColorMap[id] || PRODUCT_PALETTE[0];
}

function productRowIndex(id) {
  return productRowMap[id] ?? 0;
}

function productTag(id, name, clickable) {
  const c = colorForProductId(id);
  const tag = clickable ? 'button' : 'span';
  const attrs = clickable ? `type="button" class="prod-tag" data-product-id="${id}"` : `class="prod-tag"`;
  return `<${tag} ${attrs} style="background:${c.bg};color:${c.text};">${escapeHtml(name)}</${tag}>`;
}

function priceTag(amount) {
  return `<span class="pill-tag pill-price">${money(amount)}</span>`;
}

// best-effort wa.me link. Phone numbers in this app are stored in local
// Malaysian format (leading 0, no country code), so a leading 0 is
// swapped for Malaysia's country code — adjust this if serving other
// countries' phone formats.
function waLink(phone) {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = '60' + digits.slice(1);
  return `https://wa.me/${digits}`;
}

function phoneLink(phone) {
  const link = waLink(phone);
  if (!link) return '<span class="order-phone-none">No phone</span>';
  return `<a class="order-phone" href="${link}" target="_blank" rel="noopener noreferrer">${escapeHtml(phone)}</a>`;
}

// the shared 3-line template every order list item is built on:
// customer name / product tag + price tag / date
function orderBase(b, amount) {
  return `
    <div class="order-user">${escapeHtml(b.customer_name)}</div>
    <div class="order-tags">${productTag(b.product_id, b.product_name)}${priceTag(amount)}</div>
    <div class="order-date">${dateRangeText(b)}</div>
  `;
}

function getProductTimes(productId) {
  const p = allProducts.find(x => x.id === Number(productId));
  return {
    start: p && p.start_time ? p.start_time.slice(0, 5) : '09:00',
    end: p && p.end_time ? p.end_time.slice(0, 5) : '18:00'
  };
}

function timeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: m === 0 ? undefined : '2-digit' }).replace(/\s/g, '');
}

// "HH:MM" strings compare correctly with plain string comparison — used
// for instant local feedback while adding a slot; the server re-checks
// this authoritatively against every product's real slots regardless
function timeRangesOverlapLocal(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// renders the 10 palette swatches as selectable round buttons
function swatchPicker(selectedIndex) {
  const hasSelection = selectedIndex !== null && selectedIndex !== undefined && selectedIndex !== '';
  return PRODUCT_PALETTE.map((c, i) => `
    <button type="button" class="swatch-btn${hasSelection && Number(selectedIndex) === i ? ' is-selected' : ''}"
      data-color-index="${i}" style="background:${c.solid}" aria-label="Colour ${i + 1}"></button>
  `).join('');
}

// half-hour options from 00:00 to 23:30
function timeOptions(selected) {
  let out = '';
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const val = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const label = timeLabel(val);
      out += `<option value="${val}" ${val === selected ? 'selected' : ''}>${label}</option>`;
    }
  }
  return out;
}

// ------------------------------------------------------------
// page setup
// ------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('companyName').textContent = company.company_name + '!';

  setupTabs();
  setupLogout();
  setupStatCards();
  setupCalendarNav();
  setupWeeklyCalendarNav();
  setupProductsPage();
  setupSchedulingModeToggle();
  setupSectionsToolbar();
  setupExclusionModal();
  setupSettingsPage();
  setupCancelModal();
  setupImageModal();
  setupCalendarTooltip();
  renderCalLegend();
  applySchedulingModeUI();

  document.getElementById('exportOrdersBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    exportOrdersToExcel();
  });

  loadBookings();
  loadProducts();
  loadSections();
  loadCompany();
});

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('page-' + btn.dataset.page).classList.add('active');
    });
  });
}

function setupLogout() {
  document.getElementById('logoutBtn').addEventListener('click', () => {
    signOut();
  });
}

function renderCalLegend() {
  document.getElementById('calLegend').innerHTML = `
    <span><i class="swatch swatch-today"></i> Today</span>
    <span>Coloured bars = bookings by product &middot; hover a bar for details</span>
  `;
}

// ==============================================================
// BOOKINGS -> stats, lists, calendar
// ==============================================================
async function loadBookings() {
  try {
    const response = await api('/api/me/bookings');
    allBookings = await response.json();
  } catch (err) {
    console.error(err);
    allBookings = [];
  }

  renderStats();
  renderCalendar();
  renderWeeklyCalendar();
}

// a booking only becomes history once it is BOTH confirmed and past its
// date — an unconfirmed (pending) booking stays in "active" indefinitely
// until someone confirms the payment, even if the date has already passed
function isPastDate(b) {
  return b.end_date < todayStr();
}

function isHistory(b) {
  return b.status === 'confirmed' && isPastDate(b);
}

function isActive(b) {
  return b.status !== 'cancelled' && !isHistory(b);
}

function renderStats() {
  buildProductColorMap();

  const active = allBookings.filter(isActive);
  const history = [...allBookings.filter(isHistory)]
    .sort((a, b) => (a.end_date < b.end_date ? 1 : a.end_date > b.end_date ? -1 : 0)); // most recent first
  const cancelled = allBookings.filter(b => b.status === 'cancelled');

  document.getElementById('statTotal').textContent = allBookings.length.toLocaleString();
  document.getElementById('statActive').textContent = active.length.toLocaleString();
  document.getElementById('statCancelled').textContent = cancelled.length.toLocaleString();
  document.getElementById('statHistory').textContent = history.length.toLocaleString();

  // money actually received = confirmed bookings only
  const paid = allBookings
    .filter(b => b.status === 'confirmed')
    .reduce((sum, b) => sum + Number(b.amount || 0), 0);
  document.getElementById('totalPaid').textContent = money(paid);

  renderTotalOrders(allBookings);
  renderActiveList(active);
  renderCancelledList(cancelled);
  renderHistoryList(history);
}

const STATUS_LABEL = { confirmed: 'Confirmed', pending: 'Pending', cancelled: 'Cancelled' };
const STATUS_COLORS = {
  confirmed: { bg: 'var(--green-bg)', text: 'var(--green)' },
  pending: { bg: 'var(--slate-bg)', text: 'var(--ink-2)' },
  cancelled: { bg: 'var(--red-bg)', text: 'var(--red)' }
};

// builds a real .xlsx from whatever's currently in allBookings and
// triggers a download — no server round trip, all client-side via
// the SheetJS library loaded in dashboard.html
function exportOrdersToExcel() {
  const btn = document.getElementById('exportOrdersBtn');

  if (typeof XLSX === 'undefined') {
    alert('The Excel export library did not load. Check your internet connection and try again.');
    return;
  }
  if (!allBookings.length) {
    alert('There are no orders to export yet.');
    return;
  }

  const originalLabel = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing...'; }

  try {
    const rows = [...allBookings]
      .sort((a, b) => (a.start_date < b.start_date ? 1 : -1))
      .map(b => ({
        'Customer Name': b.customer_name,
        'Product': b.product_name,
        'Phone': b.customer_phone || '',
        'Email': b.customer_email,
        'Start Date': b.start_date,
        'End Date': b.end_date,
        'Amount': Number(b.amount || 0),
        'Status': STATUS_LABEL[b.status] || b.status,
        'Cancel Reason': b.cancel_reason || ''
      }));

    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet['!cols'] = [
      { wch: 20 }, { wch: 22 }, { wch: 16 }, { wch: 26 },
      { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 22 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Total Orders');

    const safeCompanyName = (company && company.company_name ? company.company_name : 'orders')
      .replace(/[^a-z0-9]+/gi, '_');
    const filename = `${safeCompanyName}_total_orders_${todayStr()}.xlsx`;

    XLSX.writeFile(workbook, filename);
  } catch (err) {
    console.error(err);
    alert('Could not build the Excel file. See the console for details.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalLabel; }
  }
}

// Total Orders: every booking ever made, newest first. Amount shown
// reflects status — confirmed shows what was actually received,
// anything else shows 0 since no payment has come in for it (yet).
function renderTotalOrders(all) {
  const wrap = document.getElementById('byProductList');

  if (all.length === 0) {
    wrap.innerHTML = '<p class="list-empty">No orders yet.</p>';
    return;
  }

  const sorted = [...all].sort((a, b) => (a.start_date < b.start_date ? 1 : -1));

  wrap.innerHTML = sorted.map(b => {
    const receivedAmount = b.status === 'confirmed' ? b.amount : 0;
    const sc = STATUS_COLORS[b.status] || STATUS_COLORS.pending;
    return `
      <div class="order-row">
        <div class="order-main">
          ${orderBase(b, receivedAmount)}
          <div class="order-contact">
            ${phoneLink(b.customer_phone)}
            <span class="order-email">${escapeHtml(b.customer_email)}</span>
          </div>
        </div>
        <span class="order-status" style="background:${sc.bg};color:${sc.text}">${STATUS_LABEL[b.status] || b.status}</span>
      </div>
    `;
  }).join('');
}

function renderActiveList(active) {
  const wrap = document.getElementById('activeList');

  if (active.length === 0) {
    wrap.innerHTML = '<p class="list-empty">Nothing booked ahead right now.</p>';
    return;
  }

  wrap.innerHTML = active.map(b => {
    const confirmed = b.status === 'confirmed';
    return `
      <div class="order-row" data-booking="${b.id}">
        <div class="order-main">
          ${orderBase(b, b.amount)}
          ${confirmed ? '<span class="pill-tag pill-confirmed">Booking confirmed</span>' : ''}
          <div class="order-contact">
            ${phoneLink(b.customer_phone)}
            <span class="order-email">${escapeHtml(b.customer_email)}</span>
          </div>
        </div>
        <div class="row-actions">
          <button class="pay-btn${confirmed ? ' is-cancel-mode' : ''}" data-action="${confirmed ? 'cancel' : 'confirm'}" data-id="${b.id}" data-product-id="${b.product_id}" data-product-name="${escapeHtml(b.product_name)}">
            ${confirmed ? 'Cancel payment' : 'Payment received'}
          </button>
          <button class="cancel-btn" data-action="payment_error" data-id="${b.id}" data-product-id="${b.product_id}" data-product-name="${escapeHtml(b.product_name)}" ${confirmed ? 'disabled' : ''}>
            Payment error
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderCancelledList(cancelled) {
  const wrap = document.getElementById('cancelledList');

  if (cancelled.length === 0) {
    wrap.innerHTML = '<p class="list-empty">No cancellations.</p>';
    return;
  }

  wrap.innerHTML = cancelled.map(b => {
    const isPaymentError = b.cancel_reason === 'Payment error';
    // a refund is only owed if the booking had actually been paid for —
    // that only happens via the "Cancel payment" path (post-confirmation);
    // "Payment error" bookings never collected payment, so nothing's owed
    const refunded = isPaymentError ? 0 : b.amount;
    return `
      <div class="order-row">
        <div class="order-main">
          ${orderBase(b, b.amount)}
          <div class="order-refund">Refunded: ${money(refunded)}</div>
        </div>
        <div class="tag-group">
          <span class="pill-tag pill-reason">${escapeHtml(b.cancel_reason || 'Cancelled')}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Past Orders: confirmed bookings whose date has already passed,
// most recent first (sorted in renderStats before this is called)
function renderHistoryList(history) {
  const wrap = document.getElementById('historyList');

  if (history.length === 0) {
    wrap.innerHTML = '<p class="list-empty">No past bookings yet.</p>';
    return;
  }

  wrap.innerHTML = history.map(b => `
      <div class="order-row">
        <div class="order-main">
          ${orderBase(b, b.amount)}
        </div>
      </div>
    `).join('');
}

// ==============================================================
// CANCEL REASON MODAL
// ==============================================================
const CANCEL_REASONS = [
  'Customer dissatisfaction',
  'Change of plans',
  'Personal reasons',
  'Booking made by mistake',
  'No longer needed'
];

let pendingCancelId = null;

function openCancelModal(id, productId, productName) {
  pendingCancelId = id;

  document.getElementById('cancelModalProductTag').innerHTML = productTag(productId, productName);

  document.getElementById('cancelReasonOptions').innerHTML = CANCEL_REASONS.map((r, i) => `
    <label class="reason-opt">
      <input type="radio" name="cancelReason" value="${escapeHtml(r)}" id="reason-${i}">
      <span>${escapeHtml(r)}</span>
    </label>
  `).join('');

  const confirmBtn = document.getElementById('cancelModalConfirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Cancel booking';

  document.getElementById('cancelModal').hidden = false;
}

function closeCancelModal() {
  document.getElementById('cancelModal').hidden = true;
  pendingCancelId = null;
}

function setupCancelModal() {
  const modal = document.getElementById('cancelModal');

  modal.addEventListener('change', e => {
    if (e.target.name === 'cancelReason') {
      document.getElementById('cancelModalConfirm').disabled = false;
    }
  });

  document.getElementById('cancelModalClose').addEventListener('click', closeCancelModal);
  document.getElementById('cancelModalBack').addEventListener('click', closeCancelModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeCancelModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) closeCancelModal();
  });

  document.getElementById('cancelModalConfirm').addEventListener('click', async () => {
    const reason = modal.querySelector('input[name="cancelReason"]:checked')?.value;
    if (!pendingCancelId || !reason) return;

    const btn = document.getElementById('cancelModalConfirm');
    btn.disabled = true;
    setButtonLoading(btn, 'Cancelling...');

    try {
      const response = await api(`/api/me/bookings/${pendingCancelId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'cancelled', cancel_reason: reason })
      });

      if (response.ok) {
        closeCancelModal();
        window.location.reload();
      } else {
        alert('Could not update this booking.');
        btn.disabled = false;
        btn.textContent = 'Cancel booking';
      }
    } catch (err) {
      console.error(err);
      alert('Could not connect to server.');
      btn.disabled = false;
      btn.textContent = 'Cancel booking';
    }
  });
}

// confirm payment / cancel / expand product row, handled by delegation
// so it survives re-renders
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const id = btn.dataset.id;
  const action = btn.dataset.action;
  if (!id) return;

  e.stopPropagation();

  if (action === 'cancel') {
    openCancelModal(id, btn.dataset.productId, btn.dataset.productName);
    return;
  }

  if (action === 'payment_error') {
    if (!confirm('Send a payment issue notice to the customer and cancel this booking?')) return;

    btn.disabled = true;
    try {
      const response = await api(`/api/me/bookings/${id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'cancelled', cancel_reason: 'Payment error' })
      });

      if (response.ok) loadBookings();
      else { alert('Could not update this booking.'); btn.disabled = false; }
    } catch (err) {
      console.error(err);
      alert('Could not connect to server.');
      btn.disabled = false;
    }
    return;
  }

  const originalText = btn.textContent;
  btn.disabled = true;
  setButtonLoading(btn, 'Loading...');

  try {
    const response = await api(`/api/me/bookings/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'confirmed' })
    });

    if (response.ok) {
      window.location.reload();
    } else {
      alert('Could not update this booking.');
      btn.disabled = false;
      btn.textContent = originalText;
    }
  } catch (err) {
    console.error(err);
    alert('Could not connect to server.');
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// ==============================================================
// STAT CARD EXPAND
// ==============================================================
const grid = document.getElementById('statsGrid');
let expandedCard = null;
let animating = false;

function expandCard(card) {
  if (animating || expandedCard) return;
  animating = true;
  expandedCard = card;

  const gridRect = grid.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const startTop = cardRect.top - gridRect.top;
  const startLeft = cardRect.left - gridRect.left;

  card.dataset.origTop = startTop;
  card.dataset.origLeft = startLeft;
  card.dataset.origWidth = cardRect.width;
  card.dataset.origHeight = cardRect.height;

  grid.style.height = gridRect.height + 'px';

  document.querySelectorAll('.stat-card').forEach(c => {
    if (c !== card) c.classList.add('is-sibling-hidden');
  });

  card.style.position = 'absolute';
  card.style.top = startTop + 'px';
  card.style.left = startLeft + 'px';
  card.style.width = cardRect.width + 'px';
  card.style.height = cardRect.height + 'px';
  card.classList.add('is-expanded');

  card.offsetHeight; // force reflow

  const targetHeight = window.innerWidth < 560 ? 440 : 480;

  requestAnimationFrame(() => {
    card.style.top = '0px';
    card.style.left = '0px';
    card.style.width = gridRect.width + 'px';
    card.style.height = targetHeight + 'px';
    grid.style.height = targetHeight + 'px';
  });

  // transitionend alone isn't reliable — it never fires when transitions
  // are disabled (e.g. reduced-motion accessibility settings) or if the
  // transition gets interrupted, which used to leave the card stuck
  // permanently blank. A timeout fallback guarantees it always resolves.
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    card.removeEventListener('transitionend', onEnd);
    clearTimeout(fallback);
    card.classList.add('detail-visible');
    animating = false;
  };
  const onEnd = (e) => { if (e.propertyName === 'width') finish(); };
  card.addEventListener('transitionend', onEnd);
  const fallback = setTimeout(finish, 500);
}

function collapseCard(card) {
  if (animating || expandedCard !== card) return;
  animating = true;
  card.classList.remove('detail-visible');

  const { origTop, origLeft, origWidth, origHeight } = card.dataset;

  requestAnimationFrame(() => {
    card.style.top = origTop + 'px';
    card.style.left = origLeft + 'px';
    card.style.width = origWidth + 'px';
    card.style.height = origHeight + 'px';
    grid.style.height = origHeight + 'px';
  });

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    card.removeEventListener('transitionend', onEnd);
    clearTimeout(fallback);
    card.classList.remove('is-expanded');
    card.style.cssText = '';
    grid.style.height = '';
    document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('is-sibling-hidden'));
    expandedCard = null;
    animating = false;
  };
  const onEnd = (e) => { if (e.propertyName === 'width') finish(); };
  card.addEventListener('transitionend', onEnd);
  const fallback = setTimeout(finish, 500);
}

function setupStatCards() {
  document.querySelectorAll('.stat-card').forEach(card => {
    card.querySelector('.card-summary').addEventListener('click', () => expandCard(card));
    card.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && !card.classList.contains('is-expanded')) {
        e.preventDefault();
        expandCard(card);
      }
    });
    card.querySelector('.detail-close').addEventListener('click', e => {
      e.stopPropagation();
      collapseCard(card);
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && expandedCard) collapseCard(expandedCard);
  });
}

// ==============================================================
// CALENDAR — one continuous, colour-coded bar per product per week
// ==============================================================
function setupCalendarNav() {
  document.getElementById('calPrev').addEventListener('click', () => {
    calDate.setMonth(calDate.getMonth() - 1);
    renderCalendar();
  });
  document.getElementById('calNext').addEventListener('click', () => {
    calDate.setMonth(calDate.getMonth() + 1);
    renderCalendar();
  });
}

// the date span a booking occupies on the calendar. The bar is drawn from
// the middle of the start box to the middle of the end box, so a booking that
// ends on the 16th ends at the middle of the 16th — and the next booking that
// starts on the 16th begins at that same midpoint, giving a clean turnover
// without either bar landing on the wrong day.
//
// A booking lasting exactly one calendar day (start === end) has no "next
// box" to reach on its own, so it's visually extended one day forward here —
// it then reads mid-box-to-mid-box the same as every other booking, rather
// than collapsing into a single box. (per_night bookings can never have
// start === end — a 0-night stay is rejected at booking time — so this only
// ever applies to per_day bookings, where it belongs.)
function occupiedRange(b) {
  const start = new Date(b.start_date + 'T00:00:00');
  const end = new Date(b.end_date + 'T00:00:00');
  if (start.getTime() === end.getTime()) {
    end.setDate(end.getDate() + 1);
  }
  return [start, end];
}

function renderCalendar() {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('calMonthLabel').textContent = `${monthNames[calDate.getMonth()]} ${calDate.getFullYear()}`;

  const calGrid = document.getElementById('calGrid');
  calGrid.innerHTML = '';

  const year = calDate.getFullYear();
  const month = calDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  const liveBookings = allBookings.filter(b => b.status !== 'cancelled');

  // one row per product, sharing the bottom half of the square cell —
  // thickness is dynamic, not the row count
  const rowCount = Math.max(1, allProducts.length);

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  for (let w = 0; w < cells.length / 7; w++) {
    const weekDays = cells.slice(w * 7, w * 7 + 7);

    const weekEl = document.createElement('div');
    weekEl.className = 'cal-week';

    const rowEl = document.createElement('div');
    rowEl.className = 'cal-row';

    const weekDates = weekDays.map(d => {
      if (d === null) return null;
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    });

    weekDates.forEach((dateStr, i) => {
      const cell = document.createElement('div');
      if (dateStr === null) {
        cell.className = 'cal-cell empty';
        rowEl.appendChild(cell);
        return;
      }
      cell.className = 'cal-cell' + (dateStr === today ? ' today' : '');
      const num = document.createElement('span');
      num.className = 'cal-num';
      num.textContent = weekDays[i];
      cell.appendChild(num);
      rowEl.appendChild(cell);
    });

    weekEl.appendChild(rowEl);

    const barsLayer = document.createElement('div');
    barsLayer.className = 'cal-bars-layer';
    weekEl.appendChild(barsLayer);

    renderWeekBars(barsLayer, weekDates, liveBookings, rowCount);

    calGrid.appendChild(weekEl);
  }
}

// the bottom half of the square cell is the full space available for bars.
// Booking bars are laid out relative to the box's vertical MIDDLE.
// A single product's bar is exactly half the square, centred on that
// midline (top at 25%, bottom at 75%). Each extra product shares the
// space: the stack stays centred and its total height is capped at the
// full box, so bars get thinner but never spill outside the square.
function rowGeometry(row, rowCount) {
  const count = Math.max(1, rowCount);

  // per-slot thickness: half the box for one product, then split evenly
  // once the stack would otherwise grow past the box height
  const slotPct = count === 1 ? 50 : Math.min(50, 100 / count);
  const regionPct = slotPct * count;      // 1→50, 2→100, 3→100, 4→100
  const regionTop = (100 - regionPct) / 2; // centred on the box middle

  // a hair of breathing room between stacked bars (none for a lone bar)
  const gapPct = count === 1 ? 0 : count <= 3 ? 2 : 1;
  const heightPct = Math.max(slotPct - gapPct, 2);
  const topPct = regionTop + row * slotPct + (slotPct - heightPct) / 2;

  return { topPct, heightPct };
}

// draws every product's bar segments that fall inside this week's row,
// stacked at a fixed vertical slot per product so the same product
// always lines up on the same row across the whole calendar
function renderWeekBars(layer, weekDates, bookings, rowCount) {
  const validIdx = weekDates.map((d, i) => (d ? i : null)).filter(i => i !== null);
  if (!validIdx.length) return;
  const weekStart = new Date(weekDates[validIdx[0]] + 'T00:00:00');
  const weekEnd = new Date(weekDates[validIdx[validIdx.length - 1]] + 'T00:00:00');

  // segsByRow[row] = [{ booking, startCol, endCol, touchesStart, touchesEnd }]
  const segsByRow = {};

  bookings.forEach(b => {
    const [occStart, occEnd] = occupiedRange(b);
    if (occEnd < weekStart || occStart > weekEnd) return;

    const segStart = occStart < weekStart ? weekStart : occStart;
    const segEnd = occEnd > weekEnd ? weekEnd : occEnd;

    const startCol = weekDates.indexOf(fmtDate(segStart));
    const endCol = weekDates.indexOf(fmtDate(segEnd));
    if (startCol === -1 || endCol === -1) return;

    const row = productRowIndex(b.product_id);
    if (!segsByRow[row]) segsByRow[row] = [];
    segsByRow[row].push({
      booking: b,
      startCol,
      endCol,
      touchesStart: occStart.getTime() === segStart.getTime(),
      touchesEnd: occEnd.getTime() === segEnd.getTime()
    });
  });

  Object.entries(segsByRow).forEach(([row, segs]) => {
    segs.forEach(seg => {
      // a "turnover" day: this booking's real end date is the same single
      // day as another booking's real start date, in the same product row —
      // split that one day cell in half instead of drawing a full block
      const isSingleDayCell = seg.startCol === seg.endCol;
      const turnoverIn = isSingleDayCell && seg.touchesStart && segs.some(o =>
        o !== seg && o.touchesEnd && o.startCol === seg.endCol && o.endCol === seg.endCol
      );
      const turnoverOut = isSingleDayCell && seg.touchesEnd && segs.some(o =>
        o !== seg && o.touchesStart && o.endCol === seg.startCol && o.startCol === seg.startCol
      );

      // day-mode calendar bars never show time labels — the monthly
      // view doesn't distinguish times of day, only which day is booked.
      // Turnover geometry (splitting a shared day in half) is unaffected.
      if (turnoverOut && !turnoverIn) {
        drawBar(layer, seg, Number(row), rowCount, { half: 'left' });
        return;
      }
      if (turnoverIn && !turnoverOut) {
        drawBar(layer, seg, Number(row), rowCount, { half: 'right' });
        return;
      }

      drawBar(layer, seg, Number(row), rowCount, {});
    });
  });
}

function drawBar(layer, seg, row, rowCount, opts) {
  const b = seg.booking;
  const c = colorForProductId(b.product_id);

  const colWidth = 100 / 7;
  let leftPct, widthPct;

  if (opts.half === 'left' || opts.half === 'right') {
    // turnover day — one cell shared by two bookings, drawn as a clean half
    leftPct = seg.startCol * colWidth + (opts.half === 'right' ? colWidth / 2 : 0);
    widthPct = colWidth / 2;
  } else {
    // a booking's check-in begins at the MIDDLE of its first box and its
    // check-out ends at the MIDDLE of its last box; where a segment only
    // continues from/into an adjacent week it runs to the cell edge instead
    let leftUnits = seg.startCol + (seg.touchesStart ? 0.5 : 0);
    let rightUnits = seg.endCol + (seg.touchesEnd ? 0.5 : 1);
    // a standalone single-box booking would collapse to zero width — give it
    // a centred chunk so it still reads as "in the middle of the box"
    if (rightUnits <= leftUnits) {
      leftUnits = seg.startCol + 0.25;
      rightUnits = seg.startCol + 0.75;
    }
    leftPct = leftUnits * colWidth;
    widthPct = (rightUnits - leftUnits) * colWidth;
  }

  const { topPct, heightPct } = rowGeometry(row, rowCount);

  const bar = document.createElement('div');
  bar.className = 'cal-bar' + (opts.half === 'left' ? ' is-half-left' : opts.half === 'right' ? ' is-half-right' : '');
  bar.style.top = topPct + '%';
  bar.style.height = heightPct + '%';
  bar.style.left = `calc(${leftPct}% + 2px)`;
  bar.style.width = `calc(${widthPct}% - 4px)`;
  bar.style.background = c.solid;
  bar.dataset.bookingId = b.id;

  layer.appendChild(bar);
}

// ---- hover tooltip for calendar bars ----
function setupCalendarTooltip() {
  const tooltip = document.getElementById('calTooltip');

  document.addEventListener('mouseover', e => {
    const bar = e.target.closest('.cal-bar');
    if (!bar) return;

    const booking = allBookings.find(b => String(b.id) === bar.dataset.bookingId);
    if (!booking) return;

    const c = colorForProductId(booking.product_id);
    const times = getProductTimes(booking.product_id);
    const statusColors = {
      confirmed: { bg: 'var(--green-bg)', text: 'var(--green)' },
      pending: { bg: 'var(--slate-bg)', text: 'var(--ink-2)' },
      cancelled: { bg: 'var(--red-bg)', text: 'var(--red)' }
    };
    const sc = statusColors[booking.status] || statusColors.pending;

    tooltip.innerHTML = `
      <div class="tt-title"><span class="tt-dot" style="background:${c.solid}"></span>${escapeHtml(booking.product_name)}</div>
      <div class="tt-row">${escapeHtml(booking.customer_name)}</div>
      <div class="tt-row">${dateRangeText(booking)}</div>
      <div class="tt-row">${timeLabel(times.start)} &ndash; ${timeLabel(times.end)} <span class="tt-nextday">next day</span></div>
      <div class="tt-row">${money(booking.amount)}</div>
      <span class="tt-status" style="background:${sc.bg};color:${sc.text}">${escapeHtml(booking.status)}</span>
    `;
    tooltip.hidden = false;
  });

  document.addEventListener('mousemove', e => {
    if (tooltip.hidden) return;
    const pad = 14;
    let left = e.clientX + pad;
    let top = e.clientY + pad;
    const rect = tooltip.getBoundingClientRect();
    if (left + rect.width > window.innerWidth - 8) left = e.clientX - rect.width - pad;
    if (top + rect.height > window.innerHeight - 8) top = e.clientY - rect.height - pad;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  });

  document.addEventListener('mouseout', e => {
    if (e.target.closest('.cal-bar') && !e.relatedTarget?.closest('.cal-bar')) {
      tooltip.hidden = true;
    }
  });
}

// ==============================================================
// IMAGE MANAGER MODAL (saved products only)
// ==============================================================
let imageModalProductId = null;

function openImageModal(productId) {
  imageModalProductId = productId;
  const p = allProducts.find(x => x.id === productId);
  if (!p) return;

  document.getElementById('imageModalTitle').textContent = `${p.name} — images`;
  document.getElementById('imageModalMessage').innerHTML = '';
  renderImageModalGrid();
  document.getElementById('imageModal').hidden = false;
}

function closeImageModal() {
  document.getElementById('imageModal').hidden = true;
  imageModalProductId = null;
}

function renderImageModalGrid() {
  const p = allProducts.find(x => x.id === imageModalProductId);
  const grid = document.getElementById('imageModalGrid');
  const images = (p && p.images) || [];

  grid.innerHTML = images.length === 0
    ? '<p class="list-empty">No images yet.</p>'
    : images.map(img => `
        <div class="image-modal-item">
          <img src="${getImageUrl(img.url)}" alt="${p ? escapeHtml(p.name) : 'Product image'}">
          <button class="image-modal-remove" type="button" data-image-id="${img.id}" aria-label="Remove image">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `).join('');

  document.getElementById('imageModalHint').textContent = `${images.length}/5 images used`;
  document.getElementById('imageModalUploadTrigger').disabled = images.length >= 5;
}

function setupImageModal() {
  const modal = document.getElementById('imageModal');

  document.getElementById('imageModalClose').addEventListener('click', closeImageModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeImageModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) closeImageModal();
  });

  // remove one image
  modal.addEventListener('click', async e => {
    const removeBtn = e.target.closest('.image-modal-remove');
    if (!removeBtn || !imageModalProductId) return;

    const imageId = removeBtn.dataset.imageId;
    if (!confirm('Remove this image?')) return;

    removeBtn.disabled = true;

    try {
      const res = await api(`/api/me/products/${imageModalProductId}/images/${imageId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        document.getElementById('imageModalMessage').innerHTML =
          `<div class="message-box message-error">${data.error || 'Could not remove that image.'}</div>`;
        return;
      }

      const p = allProducts.find(x => x.id === imageModalProductId);
      if (p) p.images = (p.images || []).filter(img => String(img.id) !== String(imageId));

      renderImageModalGrid();
      renderSections();
    } catch (err) {
      console.error(err);
      document.getElementById('imageModalMessage').innerHTML =
        '<div class="message-box message-error">Could not connect to server.</div>';
    }
  });

  // add new images
  const input = document.getElementById('imageModalInput');
  document.getElementById('imageModalUploadTrigger').addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    if (!imageModalProductId || !input.files.length) return;

    const p = allProducts.find(x => x.id === imageModalProductId);
    const currentCount = (p && p.images) ? p.images.length : 0;
    const room = 5 - currentCount;
    const messageBox = document.getElementById('imageModalMessage');

    if (room <= 0) {
      messageBox.innerHTML = '<div class="message-box message-error">This product already has 5 images.</div>';
      input.value = '';
      return;
    }

    const files = Array.from(input.files).slice(0, room);
    const formData = new FormData();
    files.forEach(f => formData.append('images', f));

    messageBox.innerHTML = '<div class="message-box">Uploading...</div>';

    try {
      const res = await api(`/api/me/products/${imageModalProductId}/images`, { method: 'POST', body: formData });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        messageBox.innerHTML = `<div class="message-box message-error">${data.error || 'Could not upload images.'}</div>`;
      } else {
        if (p) p.images = [...(p.images || []), ...(data.images || [])];
        messageBox.innerHTML = '<div class="message-box message-success">Images added.</div>';
        renderImageModalGrid();
        renderSections();
      }
    } catch (err) {
      console.error(err);
      messageBox.innerHTML = '<div class="message-box message-error">Could not connect to server.</div>';
    }

    input.value = '';
  });
}

// ==============================================================
// PRODUCTS TAB
// ==============================================================
function setupProductsPage() {
  const fileInput = document.getElementById('fileInput');

  fileInput.addEventListener('change', () => {
    addDraft(Array.from(fileInput.files), pendingUploadSectionId);
    fileInput.value = '';
    pendingUploadSectionId = null;
  });

  document.getElementById('saveBtn').addEventListener('click', saveChanges);
}

// one upload batch becomes one product with up to 5 images, tagged to
// whichever section's "+ Add product" button triggered the file picker
function addDraft(files, sectionId) {
  if (!files.length) return;

  const picked = files.slice(0, 5);
  // day-mode default matches a resort-style overnight window; hour-mode
  // default is a short slot, more sensible for an appointment
  const defaults = schedulingMode === 'hour'
    ? { start: '09:00', end: '09:30' }
    : { start: '15:00', end: '12:00' };

  drafts.push({
    id: draftId++,
    sectionId: sectionId || null,
    files: picked,
    previews: picked.map(f => URL.createObjectURL(f)),
    name: '',
    price: '',
    discount: '',
    description: '',
    startTime: defaults.start,
    endTime: defaults.end,
    colorIndex: null,
    timeSlots: []
  });

  markDirty();
  renderSections();
}

function markDirty() {
  const hasWork = drafts.length > 0 || Object.keys(editedProducts).length > 0;
  document.getElementById('saveBtn').disabled = !hasWork;
  document.getElementById('saveStatus').textContent = hasWork
    ? 'You have unsaved changes'
    : 'No changes to save';
}

async function loadProducts() {
  try {
    const response = await api('/api/me/products');
    const data = await response.json();
    allProducts = data.products || [];
  } catch (err) {
    console.error(err);
    allProducts = [];
  }
  renderSections();
  // product list drives the colour map and calendar row layout, so
  // refresh anything already on screen once it's known
  renderStats();
  renderCalendar();
  renderWeeklyCalendar();
}

async function loadSections() {
  try {
    const response = await api('/api/me/sections');
    const data = await response.json();
    allSections = data.sections || [];
  } catch (err) {
    console.error(err);
    allSections = [];
  }
  renderSections();
}

// ==============================================================
// PRODUCT + DRAFT CARDS (shared by every section)
// ==============================================================

function buildDraftCard(d) {
  const hoursBlock = schedulingMode === 'hour' ? `
        <p class="field-label">Available time slots</p>
        <div class="slot-tags"></div>
        <div class="time-row">
          <select class="d-slot-start">${timeOptions('09:00')}</select>
          <span class="time-sep">to</span>
          <select class="d-slot-end">${timeOptions('09:30')}</select>
          <button type="button" class="add-slot-btn">+ Add</button>
        </div>
        <p class="time-hint">Add each time customers can book &mdash; they'll choose one when booking</p>` : '';

  const card = document.createElement('div');
  card.className = 'product-card is-draft';
  card.innerHTML = `
      <div class="thumb">
        <img src="${d.previews[0]}" alt="New product">
        ${d.previews.length > 1 ? `<span class="img-count">${d.previews.length} images</span>` : ''}
      </div>
      <div class="product-body">
        <p class="field-label">Title</p>
        <input type="text" class="d-name" placeholder="e.g. Sunset cruise">
        <p class="field-label">Description</p>
        <input type="text" class="d-desc" placeholder="Short description for customers">
        <div class="price-row">
          <div>
            <p class="field-label">Price</p>
            <input type="number" class="d-price" placeholder="0.00" min="0" step="0.01">
          </div>
          <div>
            <p class="field-label">Discount <small>(optional)</small></p>
            <input type="number" class="d-discount" placeholder="0.00" min="0" step="0.01">
          </div>
        </div>${hoursBlock}
        <p class="field-label">Tag colour</p>
        <div class="swatch-picker">${swatchPicker(d.colorIndex)}</div>
        <p class="swatch-hint">Leave unpicked to auto-assign a colour</p>
        <button class="remove-product">Remove</button>
      </div>`;

  card.querySelector('.d-name').addEventListener('input', e => { d.name = e.target.value; });
  card.querySelector('.d-desc').addEventListener('input', e => { d.description = e.target.value; });
  card.querySelector('.d-price').addEventListener('input', e => { d.price = e.target.value; });
  card.querySelector('.d-discount').addEventListener('input', e => { d.discount = e.target.value; });
  card.querySelectorAll('.swatch-btn').forEach(sw => {
    sw.addEventListener('click', () => {
      d.colorIndex = Number(sw.dataset.colorIndex);
      card.querySelectorAll('.swatch-btn').forEach(s => s.classList.remove('is-selected'));
      sw.classList.add('is-selected');
      markDirty();
    });
  });
  card.querySelector('.remove-product').addEventListener('click', () => {
    drafts = drafts.filter(x => x.id !== d.id);
    markDirty();
    renderSections();
  });

  function renderDraftSlotTags() {
    const wrap = card.querySelector('.slot-tags');
    if (!wrap) return;
    wrap.innerHTML = d.timeSlots.length === 0
      ? '<span class="slot-tags-empty">No times added yet</span>'
      : d.timeSlots.map((s, i) => `
          <span class="slot-tag">${timeLabel(s.start)}\u2013${timeLabel(s.end)}
            <button type="button" class="slot-tag-remove" data-index="${i}" aria-label="Remove this time">&times;</button>
          </span>`).join('');
  }

  if (schedulingMode === 'hour') {
    renderDraftSlotTags();

    card.querySelector('.add-slot-btn').addEventListener('click', () => {
      const start = card.querySelector('.d-slot-start').value;
      const end = card.querySelector('.d-slot-end').value;
      if (start === end) { alert('Start time and end time cannot be the same.'); return; }
      if (d.timeSlots.some(s => timeRangesOverlapLocal(start, end, s.start, s.end))) {
        alert('That overlaps a time you already added for this product.');
        return;
      }
      d.timeSlots.push({ start, end });
      renderDraftSlotTags();
      markDirty();
    });

    card.querySelector('.slot-tags').addEventListener('click', e => {
      const btn = e.target.closest('.slot-tag-remove');
      if (!btn) return;
      d.timeSlots.splice(Number(btn.dataset.index), 1);
      renderDraftSlotTags();
      markDirty();
    });
  }

  return card;
}

function buildProductCard(p) {
  const mainImage = (p.images && p.images.length > 0)
    ? getImageUrl(p.images[0])
    : 'https://via.placeholder.com/240x180?text=No+Image';

  const hoursBlock = schedulingMode === 'hour' ? `
        <p class="field-label">Available time slots</p>
        <div class="slot-tags"></div>
        <div class="time-row">
          <select class="p-slot-start">${timeOptions('09:00')}</select>
          <span class="time-sep">to</span>
          <select class="p-slot-end">${timeOptions('09:30')}</select>
          <button type="button" class="add-slot-btn">+ Add</button>
        </div>
        <p class="time-hint">Add each time customers can book &mdash; they'll choose one when booking</p>` : '';

  const card = document.createElement('div');
  card.className = 'product-card';
  card.innerHTML = `
      <div class="thumb thumb-clickable" data-product-id="${p.id}">
        <img src="${mainImage}" alt="${escapeHtml(p.name)}">
        ${p.images && p.images.length > 1 ? `<span class="img-count">${p.images.length} images</span>` : ''}
        <div class="thumb-overlay">Manage images</div>
      </div>
      <div class="product-body">
        <p class="field-label">Title</p>
        <input type="text" class="p-name" value="${escapeHtml(p.name)}">
        <p class="field-label">Description</p>
        <input type="text" class="p-desc" value="${escapeHtml(p.description || '')}">
        <div class="price-row">
          <div>
            <p class="field-label">Price</p>
            <input type="number" class="p-price" value="${p.price}" min="0" step="0.01">
          </div>
          <div>
            <p class="field-label">Discount <small>(optional)</small></p>
            <input type="number" class="p-discount" value="${p.discount_price ?? ''}" min="0" step="0.01">
          </div>
        </div>${hoursBlock}
        <button class="exclusion-btn" type="button" data-product-id="${p.id}">Date Exclusion</button>
        <button class="remove-product">Remove</button>
      </div>`;

  const track = () => {
    editedProducts[p.id] = {
      name: card.querySelector('.p-name').value.trim(),
      description: card.querySelector('.p-desc').value.trim(),
      price: card.querySelector('.p-price').value,
      discount_price: card.querySelector('.p-discount').value
    };
    markDirty();
  };

  ['.p-name', '.p-desc', '.p-price', '.p-discount'].forEach(sel => {
    card.querySelector(sel).addEventListener('input', track);
  });

  card.querySelector('.thumb').addEventListener('click', () => openImageModal(p.id));
  card.querySelector('.remove-product').addEventListener('click', () => deleteProduct(p.id));
  card.querySelector('.exclusion-btn').addEventListener('click', () => openExclusionModal(p.id, p.name));

  function renderSlotTags() {
    const wrap = card.querySelector('.slot-tags');
    if (!wrap) return;
    const slots = p.time_slots || [];
    wrap.innerHTML = slots.length === 0
      ? '<span class="slot-tags-empty">No times added yet</span>'
      : slots.map(s => `
          <span class="slot-tag">${timeLabel(s.start_time)}\u2013${timeLabel(s.end_time)}
            <button type="button" class="slot-tag-remove" data-slot-id="${s.id}" aria-label="Remove this time">&times;</button>
          </span>`).join('');
  }

  if (schedulingMode === 'hour') {
    renderSlotTags();

    card.querySelector('.add-slot-btn').addEventListener('click', async () => {
      const start = card.querySelector('.p-slot-start').value;
      const end = card.querySelector('.p-slot-end').value;
      if (start === end) { alert('Start time and end time cannot be the same.'); return; }

      try {
        const res = await api(`/api/me/products/${p.id}/time-slots`, {
          method: 'POST',
          body: JSON.stringify({ start_time: start, end_time: end })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.error || 'Could not add that time.'); return; }

        p.time_slots = [...(p.time_slots || []), data.slot].sort((a, b) => a.start_time < b.start_time ? -1 : 1);
        renderSlotTags();
      } catch (err) {
        console.error(err);
        alert('Could not connect to server.');
      }
    });

    card.querySelector('.slot-tags').addEventListener('click', async e => {
      const btn = e.target.closest('.slot-tag-remove');
      if (!btn) return;
      const slotId = btn.dataset.slotId;

      try {
        const res = await api(`/api/me/products/${p.id}/time-slots/${slotId}`, { method: 'DELETE' });
        if (!res.ok) { alert('Could not remove that time.'); return; }
        p.time_slots = (p.time_slots || []).filter(s => String(s.id) !== String(slotId));
        renderSlotTags();
      } catch (err) {
        console.error(err);
        alert('Could not connect to server.');
      }
    });
  }

  return card;
}

// ==============================================================
// SECTIONS — group products; "General" (section_id null) always exists
// ==============================================================

function renderSections() {
  const wrap = document.getElementById('sectionsWrap');
  const emptyState = document.getElementById('emptyState');
  if (!wrap) return;
  wrap.innerHTML = '';

  emptyState.hidden = (allProducts.length + drafts.length) > 0;

  if (allSections.length === 0) {
    // sections are still loading (or failed to load) — the backend
    // always guarantees at least one exists once loadSections() resolves
    wrap.innerHTML = '<p class="section-empty-hint">Loading sections&hellip;</p>';
    return;
  }

  allSections.forEach(section => {
    const sectionProducts = allProducts.filter(p => (p.section_id ?? null) === section.id);
    const sectionDrafts = drafts.filter(d => (d.sectionId ?? null) === section.id);

    const block = document.createElement('div');
    block.className = 'product-section';
    block.innerHTML = `
      <div class="product-section-head">
        <input type="text" class="section-name-input" value="${escapeHtml(section.name)}">
        <button type="button" class="section-add-product-btn">+ Add product</button>
        <button type="button" class="section-delete-btn">Delete section</button>
      </div>
      <div class="products-grid"></div>
      ${(sectionProducts.length === 0 && sectionDrafts.length === 0)
        ? '<p class="section-empty-hint">No products in this section yet.</p>' : ''}
    `;

    const grid = block.querySelector('.products-grid');
    sectionDrafts.forEach(d => grid.appendChild(buildDraftCard(d)));
    sectionProducts.forEach(p => grid.appendChild(buildProductCard(p)));

    block.querySelector('.section-add-product-btn').addEventListener('click', () => {
      pendingUploadSectionId = section.id;
      document.getElementById('fileInput').click();
    });

    const nameInput = block.querySelector('.section-name-input');
    nameInput.addEventListener('change', () => renameSection(section.id, nameInput.value.trim()));
    block.querySelector('.section-delete-btn').addEventListener('click', () => deleteSection(section.id, section.name));

    wrap.appendChild(block);
  });
}

function setupSectionsToolbar() {
  document.getElementById('addSectionBtn').addEventListener('click', async () => {
    const name = prompt('Name this section (e.g. "Barber 1", "Deluxe rooms"):');
    if (!name || !name.trim()) return;

    try {
      const res = await api('/api/me/sections', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not create section.');
        return;
      }
      await loadSections();
    } catch (err) {
      console.error(err);
      alert('Could not connect to server.');
    }
  });
}

async function renameSection(id, name) {
  if (name) {
    try {
      const res = await api(`/api/me/sections/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not rename section.');
      }
    } catch (err) {
      console.error(err);
      alert('Could not connect to server.');
    }
  }
  await loadSections();
}

async function deleteSection(id, name) {
  if (!confirm(`Delete "${name}"? Its products move into another section rather than being deleted.`)) return;

  try {
    const res = await api(`/api/me/sections/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Could not delete that section.');
      return;
    }
    await loadSections();
    await loadProducts();
  } catch (err) {
    console.error(err);
    alert('Could not connect to server.');
  }
}

// ==============================================================
// SCHEDULING MODE — 'day' (resorts: book a date range) or
// 'hour' (barbershops: book a time slot)
// ==============================================================

function setupSchedulingModeToggle() {
  document.querySelectorAll('#schedulingModeToggle .mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      if (mode === schedulingMode) return;

      const hint = document.getElementById('schedulingModeHint');
      const buttons = document.querySelectorAll('#schedulingModeToggle .mode-btn');
      buttons.forEach(b => b.disabled = true);
      hint.textContent = 'Saving...';

      try {
        const res = await api('/api/me/scheduling-mode', {
          method: 'PUT',
          body: JSON.stringify({ scheduling_mode: mode })
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          hint.textContent = data.error || 'Could not switch mode.';
        } else {
          schedulingMode = mode;
          sessionStorage.setItem('company', JSON.stringify({ ...company, scheduling_mode: mode }));
          applySchedulingModeUI();
          renderSections();
          renderCalendar();
          renderWeeklyCalendar();
        }
      } catch (err) {
        console.error(err);
        hint.textContent = 'Could not connect to server.';
      }

      buttons.forEach(b => b.disabled = false);
    });
  });
}

function applySchedulingModeUI() {
  document.querySelectorAll('#schedulingModeToggle .mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === schedulingMode);
  });
  const hint = document.getElementById('schedulingModeHint');
  if (hint) {
    hint.textContent = schedulingMode === 'hour'
      ? "Customers book a specific time slot. A product's hours can't overlap another product's."
      : 'Customers book a date range, like a hotel stay or a multi-day tour.';
  }

  const monthly = document.getElementById('monthlyCalendarWrap');
  const weekly = document.getElementById('weeklyCalendarWrap');
  if (monthly) monthly.hidden = schedulingMode === 'hour';
  if (weekly) weekly.hidden = schedulingMode !== 'hour';
}

// ==============================================================
// DATE EXCLUSION MODAL — manually block a product off on specific dates
// ==============================================================

let exclusionProductId = null;
let exclusionCalDate = new Date();
let exclusionDates = new Map(); // date string -> {start_time, end_time} or {start_time:null, end_time:null}

function setupExclusionModal() {
  const modal = document.getElementById('exclusionModal');

  document.getElementById('exclusionModalClose').addEventListener('click', closeExclusionModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeExclusionModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) closeExclusionModal();
  });

  document.getElementById('exclusionCalPrev').addEventListener('click', () => {
    exclusionCalDate.setMonth(exclusionCalDate.getMonth() - 1);
    renderExclusionCalendar();
  });
  document.getElementById('exclusionCalNext').addEventListener('click', () => {
    exclusionCalDate.setMonth(exclusionCalDate.getMonth() + 1);
    renderExclusionCalendar();
  });

  document.getElementById('exclusionTimeToggle').addEventListener('change', e => {
    document.getElementById('exclusionTimeRow').hidden = !e.target.checked;
  });

  document.getElementById('exclusionCalGrid').addEventListener('click', async e => {
    const cell = e.target.closest('.excl-cell');
    if (!cell || cell.classList.contains('empty') || cell.classList.contains('is-past')) return;

    const dateStr = cell.dataset.date;
    if (!dateStr || !exclusionProductId) return;

    const wasExcluded = exclusionDates.has(dateStr);
    cell.style.pointerEvents = 'none';
    const messageBox = document.getElementById('exclusionModalMessage');

    const noteTime = schedulingMode === 'hour' && document.getElementById('exclusionTimeToggle').checked;
    const body = { date: dateStr };
    if (noteTime) {
      body.start_time = document.getElementById('exclusionStartTime').value;
      body.end_time = document.getElementById('exclusionEndTime').value;
    }

    try {
      const res = wasExcluded
        ? await api(`/api/me/products/${exclusionProductId}/exclusions/${dateStr}`, { method: 'DELETE' })
        : await api(`/api/me/products/${exclusionProductId}/exclusions`, {
            method: 'POST',
            body: JSON.stringify(body)
          });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        messageBox.innerHTML = `<div class="message-box message-error">${data.error || 'Could not update that date.'}</div>`;
      } else {
        messageBox.innerHTML = '';
        if (wasExcluded) {
          exclusionDates.delete(dateStr);
        } else {
          exclusionDates.set(dateStr, {
            start_time: noteTime ? body.start_time : null,
            end_time: noteTime ? body.end_time : null
          });
        }
        renderExclusionCalendar();
      }
    } catch (err) {
      console.error(err);
      messageBox.innerHTML = '<div class="message-box message-error">Could not connect to server.</div>';
    }

    cell.style.pointerEvents = '';
  });
}

async function openExclusionModal(productId, productName) {
  exclusionProductId = productId;
  exclusionCalDate = new Date();

  document.getElementById('exclusionModalTitle').textContent = `Date Exclusion \u2014 ${productName}`;
  document.getElementById('exclusionModalMessage').innerHTML = '';

  const toggleWrap = document.getElementById('exclusionTimeToggleWrap');
  const toggle = document.getElementById('exclusionTimeToggle');
  const timeRow = document.getElementById('exclusionTimeRow');
  toggleWrap.hidden = schedulingMode !== 'hour';
  toggle.checked = false;
  timeRow.hidden = true;
  if (schedulingMode === 'hour') {
    document.getElementById('exclusionStartTime').innerHTML = timeOptions('10:00');
    document.getElementById('exclusionEndTime').innerHTML = timeOptions('11:00');
  }

  try {
    const res = await api(`/api/me/products/${productId}/exclusions`);
    const data = await res.json();
    exclusionDates = new Map((data.exclusions || []).map(e => [e.date, { start_time: e.start_time, end_time: e.end_time }]));
  } catch (err) {
    console.error(err);
    exclusionDates = new Map();
  }

  renderExclusionCalendar();
  document.getElementById('exclusionModal').hidden = false;
}

function closeExclusionModal() {
  document.getElementById('exclusionModal').hidden = true;
  exclusionProductId = null;
}

function renderExclusionCalendar() {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('exclusionCalLabel').textContent =
    `${monthNames[exclusionCalDate.getMonth()]} ${exclusionCalDate.getFullYear()}`;

  const grid = document.getElementById('exclusionCalGrid');
  grid.innerHTML = '';

  const year = exclusionCalDate.getFullYear();
  const month = exclusionCalDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'excl-cell empty';
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isPast = dateStr < today;
    const exclusion = exclusionDates.get(dateStr);
    const cell = document.createElement('div');
    cell.className = 'excl-cell'
      + (exclusion ? ' is-excluded' : '')
      + (isPast ? ' is-past' : '');
    cell.textContent = d;
    cell.dataset.date = dateStr;
    if (exclusion) {
      cell.title = exclusion.start_time
        ? `Blocked \u2014 ${timeLabel(exclusion.start_time)}\u2013${timeLabel(exclusion.end_time)} noted`
        : 'Blocked all day';
    }
    grid.appendChild(cell);
  }
}

// ==============================================================
// WEEKLY CALENDAR (Hours mode) — Mon-Sun, positions each booking by
// its product's configured hours. NOTE: since a booking doesn't yet
// carry its own time slot (only its product does), two bookings for
// the same product on the same day would currently draw on top of
// each other — see the enhancement notes for the real fix.
// ==============================================================

function setupWeeklyCalendarNav() {
  document.getElementById('weekPrev').addEventListener('click', () => {
    weekDate.setDate(weekDate.getDate() - 7);
    renderWeeklyCalendar();
  });
  document.getElementById('weekNext').addEventListener('click', () => {
    weekDate.setDate(weekDate.getDate() + 7);
    renderWeeklyCalendar();
  });
}

function mondayOf(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function renderWeeklyCalendar() {
  const wrap = document.getElementById('weeklyCalendarWrap');
  if (!wrap || wrap.hidden) return;

  const monday = mondayOf(weekDate);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    days.push(d);
  }

  document.getElementById('weekLabel').textContent =
    `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} \u2013 ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  document.getElementById('weekDow').innerHTML = '<span></span>' + days.map(d =>
    `<span>${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}</span>`
  ).join('');

  const hoursWrap = document.getElementById('weekHours');
  hoursWrap.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'week-hour-label';
    lbl.textContent = timeLabel(`${String(h).padStart(2, '0')}:00`);
    hoursWrap.appendChild(lbl);
  }

  const gridWrap = document.getElementById('weekGrid');
  gridWrap.innerHTML = '';
  gridWrap.style.height = (24 * 44) + 'px';

  const liveBookings = allBookings.filter(b => b.status !== 'cancelled');
  const today = todayStr();

  days.forEach(day => {
    const dateStr = fmtDate(day);
    const col = document.createElement('div');
    col.className = 'week-day-col' + (dateStr === today ? ' week-today-col' : '');

    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'week-hour-line';
      line.style.top = (h * 44) + 'px';
      col.appendChild(line);
    }

    liveBookings
      .filter(b => b.start_date === dateStr)
      .forEach(b => {
        // a booking's OWN time is its actual booked slot — the product
        // itself may offer several different slots, so falling back to
        // "the product's time" would show the same time for every
        // appointment regardless of which slot was really chosen
        const start = b.start_time ? b.start_time.slice(0, 5) : getProductTimes(b.product_id).start;
        const end = b.end_time ? b.end_time.slice(0, 5) : getProductTimes(b.product_id).end;
        const [sh, sm] = start.split(':').map(Number);
        const [eh, em] = end.split(':').map(Number);
        const startMin = sh * 60 + sm;
        let endMin = eh * 60 + em;
        if (endMin <= startMin) endMin += 24 * 60;
        endMin = Math.min(endMin, 24 * 60);

        const c = colorForProductId(b.product_id);
        const block = document.createElement('div');
        block.className = 'week-block';
        block.style.background = c.solid;
        block.style.top = (startMin / 60 * 44) + 'px';
        block.style.height = Math.max((endMin - startMin) / 60 * 44, 20) + 'px';
        block.innerHTML = `${escapeHtml(b.product_name)}<span class="wb-time">${timeLabel(start)}\u2013${timeLabel(end)}</span>`;
        block.title = `${b.customer_name} \u00b7 ${b.product_name}`;
        col.appendChild(block);
      });

    gridWrap.appendChild(col);
  });
}


async function deleteProduct(id) {
  if (!confirm('Remove this product? Its bookings will be removed too.')) return;

  try {
    const res = await api(`/api/me/products/${id}`, { method: 'DELETE' });
    if (!res.ok) { alert('Could not remove that product.'); return; }
    delete editedProducts[id];
    markDirty();
    loadProducts();
    loadBookings();
  } catch (err) {
    console.error(err);
    alert('Could not connect to server.');
  }
}

async function saveChanges() {
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('saveStatus');

  // every draft needs a title and price before it can go live
  const incomplete = drafts.find(d => !d.name.trim() || !d.price);
  if (incomplete) {
    status.textContent = 'Give every new product a title and a price first';
    return;
  }

  saveBtn.disabled = true;
  status.textContent = 'Saving...';

  try {
    for (const d of drafts) {
      const formData = new FormData();
      formData.append('company_id', company.id);
      formData.append('name', d.name.trim());
      formData.append('description', d.description.trim());
      formData.append('price', d.price);
      if (d.discount) formData.append('discount_price', d.discount);
      formData.append('start_time', d.startTime);
      formData.append('end_time', d.endTime);
      if (d.colorIndex !== null && d.colorIndex !== undefined) {
        formData.append('color_index', d.colorIndex);
      }
      if (d.sectionId) formData.append('section_id', d.sectionId);
      d.files.forEach(file => formData.append('images', file));

      const res = await api('/api/me/products', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not save a new product');
      }

      if (schedulingMode === 'hour' && d.timeSlots.length > 0) {
        const productData = await res.json().catch(() => ({}));
        const newProductId = productData.id;
        const slotErrors = [];

        for (const slot of d.timeSlots) {
          const slotRes = await api(`/api/me/products/${newProductId}/time-slots`, {
            method: 'POST',
            body: JSON.stringify({ start_time: slot.start, end_time: slot.end })
          });
          if (!slotRes.ok) {
            const slotData = await slotRes.json().catch(() => ({}));
            slotErrors.push(slotData.error || `${slot.start}\u2013${slot.end} could not be added`);
          }
        }

        if (slotErrors.length > 0) {
          status.textContent = `"${d.name.trim()}" saved, but: ${slotErrors.join('; ')}`;
        }
      }
    }

    for (const [id, values] of Object.entries(editedProducts)) {
      const res = await api(`/api/me/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: values.name,
          description: values.description,
          price: values.price,
          discount_price: values.discount_price || null,
          start_time: values.start_time,
          end_time: values.end_time
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not update a product');
      }
    }

    drafts = [];
    editedProducts = {};
    renderSections();
    await loadProducts();
    await loadBookings();

    status.textContent = 'All changes saved';
    saveBtn.disabled = true;

  } catch (err) {
    console.error(err);
    status.textContent = err.message && err.message !== 'Could not save a new product' && err.message !== 'Could not update a product'
      ? err.message
      : 'Could not save. Check the server and try again.';
    saveBtn.disabled = false;
  }
}

// ==============================================================
// SETTINGS TAB
// ==============================================================
function setupSettingsPage() {
  const qrInput = document.getElementById('qrInput');
  document.getElementById('qrTrigger').addEventListener('click', () => qrInput.click());

  qrInput.addEventListener('change', async () => {
    const file = qrInput.files[0];
    if (!file) return;

    const messageBox = document.getElementById('qrMessage');
    const formData = new FormData();
    formData.append('qr', file);

    try {
      const response = await api('/api/me/qr', {
        method: 'POST',
        body: formData
      });
      const data = await response.json();

      if (response.ok) {
        showQr(data.qr_code_url);
        messageBox.innerHTML = '<div class="message-box message-success">QR uploaded. Customers will see it after booking.</div>';
      } else {
        messageBox.innerHTML = `<div class="message-box message-error">${data.error || 'Could not upload the QR.'}</div>`;
      }
    } catch (err) {
      console.error(err);
      messageBox.innerHTML = '<div class="message-box message-error">Could not connect to server.</div>';
    }

    qrInput.value = '';
  });

  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const messageBox = document.getElementById('settingsMessage');
    const updated = {
      company_name: document.getElementById('setName').value.trim(),
      email: document.getElementById('setEmail').value.trim(),
      phone: document.getElementById('setPhone').value.trim(),
      whatsapp: document.getElementById('setWhatsapp').value.replace(/\D/g, ''),
      address: document.getElementById('setAddress').value.trim()
    };

    try {
      const response = await api('/api/me', {
        method: 'PUT',
        body: JSON.stringify(updated)
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        const saved = { ...company, ...updated };
        sessionStorage.setItem('company', JSON.stringify(saved));

        document.getElementById('companyName').textContent = updated.company_name + '!';
        messageBox.innerHTML = '<div class="message-box message-success">Saved.</div>';
      } else {
        messageBox.innerHTML = `<div class="message-box message-error">${data.error || 'Could not save changes.'}</div>`;
      }
    } catch (err) {
      console.error(err);
      messageBox.innerHTML = '<div class="message-box message-error">Could not connect to server.</div>';
    }
  });

  // password change is its own form: it needs the current password,
  // and it ends every session including this one
  document.getElementById('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const messageBox = document.getElementById('passwordMessage');
    const current = document.getElementById('currentPassword').value;
    const next = document.getElementById('newPassword').value;
    const confirmed = document.getElementById('confirmPassword').value;

    if (!current || !next) {
      messageBox.innerHTML = '<div class="message-box message-error">Fill in both password fields.</div>';
      return;
    }
    if (next.length < 8) {
      messageBox.innerHTML = '<div class="message-box message-error">New password must be at least 8 characters.</div>';
      return;
    }
    if (next !== confirmed) {
      messageBox.innerHTML = '<div class="message-box message-error">The new passwords do not match.</div>';
      return;
    }

    try {
      const response = await api('/api/me/password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: current, new_password: next })
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        messageBox.innerHTML = '<div class="message-box message-success">Password changed. Signing you out...</div>';
        setTimeout(() => signOut('Password changed. Please log in again.'), 1500);
      } else {
        messageBox.innerHTML = `<div class="message-box message-error">${data.error || 'Could not change the password.'}</div>`;
      }
    } catch (err) {
      console.error(err);
      messageBox.innerHTML = '<div class="message-box message-error">Could not connect to server.</div>';
    }
  });
}

async function loadCompany() {
  try {
    const response = await api('/api/me');
    if (!response.ok) return;

    const data = await response.json();

    // these drive wording and totals across the whole dashboard
    pricingMode = data.pricing_mode || 'per_day';
    currency = data.currency || '$';
    schedulingMode = data.scheduling_mode || 'day';
    sessionStorage.setItem('company', JSON.stringify({ ...company, pricing_mode: pricingMode, currency, scheduling_mode: schedulingMode }));
    applySchedulingModeUI();
    renderStats();
    renderCalendar();
    renderWeeklyCalendar();
    renderSections();

    document.getElementById('setName').value = data.company_name || '';
    document.getElementById('setEmail').value = data.email || '';
    document.getElementById('setPhone').value = data.phone || '';
    document.getElementById('setWhatsapp').value = data.whatsapp || '';
    document.getElementById('setAddress').value = data.address || '';

    if (data.qr_code_url) showQr(data.qr_code_url);
  } catch (err) {
    console.error(err);
  }
}

function showQr(url) {
  const img = document.getElementById('qrPreview');
  img.src = getImageUrl(url);
  img.hidden = false;
  document.getElementById('qrPlaceholder').hidden = true;
}
