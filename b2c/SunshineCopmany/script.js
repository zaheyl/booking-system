// script.js (Sunshine Travel Co. — B2C landing page)
// Loads products for the chosen date range and shows whether each one
// is free. Available -> "Checkout" button. Taken -> stamped notice.

// settings come from config.js, which must load first
if (!window.SITE) throw new Error('config.js must be loaded before script.js');

const API_URL = window.SITE.API_URL;
const COMPANY_ID = window.SITE.COMPANY_ID;

// company-level display settings — same fields the B2B dashboard uses
// (pricing_mode: 'per_day' | 'per_night', currency: '$' | 'RM' | ...).
// Pulled from the public company lookup so wording and totals always
// match what the operator configured, with sane fallbacks if the
// server hasn't shipped those fields yet.
let company = null;
let pricingMode = 'per_day';
let currency = '$';

// booked dates for the next 3 months, shared across every product —
// { productId: Set('YYYY-MM-DD') }. Filled in once at startup by
// scanning day by day using the SAME /api/public/products?from=&to=
// call the main grid already uses (which returns every product's
// status for that day in one response) — so the request count is
// ~92 total for the whole page, not 92 per product.
const bookedByProduct = {};
let bookedMapReady = false;

// ------------------------------------------------------------
// startup
// ------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  const fromInput = document.getElementById('fromDate');
  const toInput = document.getElementById('toDate');

  // default to today -> today, so there is always a range to check
  const today = new Date().toISOString().split('T')[0];
  fromInput.value = today;
  toInput.value = today;
  fromInput.min = today;
  toInput.min = today;

  // the "until" date can never be before the "from" date
  fromInput.addEventListener('change', () => {
    toInput.min = fromInput.value;
    if (toInput.value < fromInput.value) toInput.value = fromInput.value;
    loadProducts();
  });

  toInput.addEventListener('change', loadProducts);
  document.getElementById('checkBtn').addEventListener('click', loadProducts);

  await loadCompany();
  await loadProducts();
  loadBookedDatesMap();
});

// public lookup — only returns fields safe to show a customer
// (see /api/public/company/:id in server.js).
async function loadCompany() {
  try {
    const response = await fetch(`${API_URL}/api/public/company/${COMPANY_ID}`);
    if (response.status === 429) {
      console.warn('Company info skipped: server is rate limiting (429). Using defaults ($ / per day) for now.');
      return;
    }
    if (response.ok) {
      company = await response.json();
      pricingMode = company.pricing_mode || 'per_day';
      currency = company.currency || '$';
    }
  } catch (err) {
    console.error(err);
  }
}

function getDates() {
  return {
    from: document.getElementById('fromDate').value,
    to: document.getElementById('toDate').value
  };
}

// turns "2026-08-01" into "Aug 1, 2026"
function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function countDays(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.round((b - a) / 86400000) + 1;
}

// "3 nights" for a homestay-style listing, "3 days" for a tour —
// mirrors durationText() in the B2B dashboard so the two never disagree
function durationCount(from, to) {
  const days = countDays(from, to);
  return pricingMode === 'per_night' ? Math.max(days - 1, 1) : days;
}

function unitLabel(count) {
  const unit = pricingMode === 'per_night' ? 'night' : 'day';
  return `${unit}${count === 1 ? '' : 's'}`;
}

function money(value) {
  const amount = Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'RM' ? `RM ${amount}` : `${currency}${amount}`;
}

function getImageUrl(url) {
  if (!url) return 'https://via.placeholder.com/280x180?text=No+Image';
  if (url.startsWith('http')) return url;
  return API_URL + url;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function timeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: m === 0 ? undefined : '2-digit' }).replace(/\s/g, '');
}

// ------------------------------------------------------------
// load products for the selected dates
// ------------------------------------------------------------
async function loadProducts() {
  const carousel = document.getElementById('carousel');
  const summary = document.getElementById('dateSummary');
  const { from, to } = getDates();

  if (!from || !to) {
    carousel.innerHTML = '<p class="grid-note">Choose a start and end date to see what\'s free.</p>';
    summary.textContent = '';
    return;
  }

  const count = durationCount(from, to);
  summary.textContent = from === to
    ? `Showing availability for ${formatDate(from)}`
    : `Showing availability for ${formatDate(from)} to ${formatDate(to)} (${count} ${unitLabel(count)})`;

  carousel.innerHTML = '<p class="grid-note">Checking the ledger for these dates...</p>';

  try {
    // NOTE: public/anonymous browsing goes through /api/public/*
    // — this is the same set of routes the Homestay site uses, and
    // it always scopes results to COMPANY_ID so the two sites can
    // never bleed into each other's data.
    const response = await fetch(
      `${API_URL}/api/public/products?company_id=${COMPANY_ID}&from=${from}&to=${to}`
    );

    if (response.status === 429) {
      carousel.innerHTML = '<p class="grid-note">Busy at the desk right now &mdash; give it a moment and try again.</p>';
      return;
    }

    const data = await response.json();
    const products = data.products || [];

    carousel.innerHTML = '';

    if (products.length === 0) {
      carousel.innerHTML = '<p class="grid-note">Nothing listed here yet &mdash; check back soon.</p>';
      return;
    }

    products.forEach(product => {
      carousel.appendChild(createProductCard(product, from, to));
    });

  } catch (err) {
    console.error(err);
    carousel.innerHTML = '<p class="grid-note">The tide\'s out on our connection &mdash; is the server running?</p>';
  }
}

// builds one product card
function createProductCard(product, from, to) {
  const card = document.createElement('div');
  card.className = 'product-card' + (product.available ? '' : ' is-unavailable');

  const mainImage = (product.images && product.images.length > 0)
    ? getImageUrl(product.images[0])
    : 'https://via.placeholder.com/280x180?text=No+Image';

  const unitPrice = product.discount_price ?? product.price;
  const total = Number(unitPrice) * durationCount(from, to);

  let priceHtml;
  if (product.discount_price) {
    priceHtml = `
      <span class="original-price">${money(product.price)}</span>
      <span class="discount-price">${money(product.discount_price)}</span>
      <span class="per-day">per ${pricingMode === 'per_night' ? 'night' : 'day'}</span>
    `;
  } else {
    priceHtml = `
      <span class="normal-price">${money(product.price)}</span>
      <span class="per-day">per ${pricingMode === 'per_night' ? 'night' : 'day'}</span>
    `;
  }

  const stampHtml = product.available
    ? '<span class="stamp is-open"><span class="dot"></span>Open</span>'
    : '<span class="stamp is-closed"><span class="dot"></span>Booked</span>';

  const hoursHtml = (product.start_time && product.end_time)
    ? `<p class="hours-note">${timeLabel(product.start_time)} &ndash; ${timeLabel(product.end_time)}</p>`
    : '';

  const count = durationCount(from, to);
  const actionHtml = product.available
    ? `<button class="book-btn">Checkout</button>
       <p class="total-note">${count} ${unitLabel(count)} &middot; total ${money(total)}</p>`
    : `<p class="not-available"><em>Fully booked for these dates</em></p>`;

  card.innerHTML = `
    <div class="thumb-frame">
      <img src="${mainImage}" alt="${escapeHtml(product.name)}">
      ${stampHtml}
    </div>
    <div class="card-body">
      <h3>${escapeHtml(product.name)}</h3>
      <p class="desc">${escapeHtml(product.description || '')}</p>
      ${hoursHtml}
      <div class="price-row">${priceHtml}</div>
      ${actionHtml}
      <div class="booked-strip" data-booked-strip data-product-id="${product.id}">
        <span class="booked-strip-label">Already locked in &middot; next 3 months</span>
        ${bookedMapReady ? formatBookedStrip(product.id) : '<p class="booked-strip-hint">Checking booked dates&hellip;</p>'}
      </div>
    </div>
  `;

  const bookBtn = card.querySelector('.book-btn');
  if (bookBtn) {
    // carry the chosen dates over to the booking page
    bookBtn.addEventListener('click', () => {
      window.open(`booking.html?id=${product.id}&from=${from}&to=${to}`, '_blank');
    });
  }

  return card;
}

// ------------------------------------------------------------
// booked-dates strip — which days in the next 3 months are already
// taken, for every product at once. Walks the days ONE AT A TIME
// (not in parallel, no bursts) using the same endpoint the main grid
// uses, so a single request per day covers every product's status.
// ------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmtDateLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadBookedDatesMap() {
  const start = new Date();
  const days = [];
  for (let i = 0; i < 92; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(fmtDateLocal(d));
  }

  let rateLimitStreak = 0;

  for (const dateStr of days) {
    try {
      const response = await fetch(
        `${API_URL}/api/public/products?company_id=${COMPANY_ID}&from=${dateStr}&to=${dateStr}`
      );

      if (response.status === 429) {
        rateLimitStreak++;
        // back off a bit longer than usual, then keep going — but if
        // it keeps happening, stop rather than loop on a blocked server
        if (rateLimitStreak >= 4) {
          console.warn('Booked-dates scan stopped early: server is rate limiting.');
          break;
        }
        await sleep(2000);
        continue;
      }
      rateLimitStreak = 0;

      const data = await response.json();
      const products = data.products || [];

      products.forEach(p => {
        if (p.available === false) {
          if (!bookedByProduct[p.id]) bookedByProduct[p.id] = new Set();
          bookedByProduct[p.id].add(dateStr);
        }
      });
    } catch (err) {
      console.error(err);
    }

    // refresh what's on screen as results come in, so cards fill in
    // progressively instead of waiting for the whole 3-month scan
    refreshBookedStrips();
    await sleep(150);
  }

  bookedMapReady = true;
  refreshBookedStrips();
}

function formatBookedStrip(productId) {
  const set = bookedByProduct[productId];
  const dates = set ? Array.from(set).sort() : [];

  if (dates.length === 0) {
    return bookedMapReady
      ? '<p class="booked-strip-hint">Nothing booked in the next 3 months.</p>'
      : '<p class="booked-strip-hint">Checking booked dates&hellip;</p>';
  }

  const monthNames = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const groups = [];
  let currentKey = null;

  dates.forEach(dateStr => {
    const [, m, day] = dateStr.split('-');
    const key = `${dateStr.slice(0, 4)}-${m}`;
    if (key !== currentKey) {
      groups.push({ label: monthNames[Number(m) - 1], days: [] });
      currentKey = key;
    }
    groups[groups.length - 1].days.push(day);
  });

  const groupsHtml = groups.map(g => `
    <div class="booked-month">
      <span class="booked-month-label">${g.label}</span>
      <div class="booked-chips">${g.days.map(d => `<span class="booked-chip">${d}</span>`).join('')}</div>
    </div>
  `).join('');

  return `<div class="booked-strip-inner">${groupsHtml}</div>`;
}

function refreshBookedStrips() {
  document.querySelectorAll('[data-booked-strip]').forEach(el => {
    const productId = el.dataset.productId;
    const label = el.querySelector('.booked-strip-label');
    el.innerHTML = '';
    if (label) el.appendChild(label);
    el.insertAdjacentHTML('beforeend', formatBookedStrip(productId));
  });
}