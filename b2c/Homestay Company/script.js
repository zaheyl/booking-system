// script.js (Barber Retreat and Resort Co. — B2C landing page)
// Same backend, same data shape as every other client site. The one
// thing this site does differently: it reads the company's
// scheduling_mode and switches its whole planner between a date-range
// flow (Day mode) and a single-date flow (Hours mode).

if (!window.SITE) throw new Error('config.js must be loaded before script.js');

const API_URL = window.SITE.API_URL;
const COMPANY_ID = window.SITE.COMPANY_ID;
const STRIP_DAYS = 14;   // how many days the Day-mode availability strip shows

let currency = 'RM';
let schedulingMode = 'day';
let pricingMode = 'per_day';

// ------------------------------------------------------------
// small date helpers
// ------------------------------------------------------------
function toISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toISO(d);
}

function countDays(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function timeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: m === 0 ? undefined : '2-digit' });
}

function money(value) {
  return `${currency} ${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getImageUrl(url) {
  if (!url) return 'https://via.placeholder.com/600x400?text=No+Image';
  if (url.startsWith('http')) return url;
  return API_URL + url;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ------------------------------------------------------------
// startup
// ------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  await loadCompany();
  setupPlannerForMode();
  document.getElementById('checkBtn').addEventListener('click', loadServices);
  loadServices();
});

async function loadCompany() {
  try {
    const res = await fetch(`${API_URL}/api/public/company/${COMPANY_ID}`);
    if (!res.ok) return;
    const company = await res.json();

    schedulingMode = company.scheduling_mode || 'day';
    currency = company.currency || 'RM';

    document.getElementById('wordmarkPlace').textContent = company.address || '';
    document.getElementById('footAddress').textContent = company.address || '';
  } catch (err) {
    console.error(err);
  }
}

// shows the right planner block and sets sensible defaults for it
function setupPlannerForMode() {
  const dayPlanner = document.getElementById('dayModePlanner');
  const hourPlanner = document.getElementById('hourModePlanner');
  const hint = document.getElementById('modeHint');
  const today = toISO(new Date());

  if (schedulingMode === 'hour') {
    hourPlanner.hidden = false;
    dayPlanner.hidden = true;
    hint.textContent = 'Pick a date — each service shows its own appointment time.';

    const visitDate = document.getElementById('visitDate');
    visitDate.value = today;
    visitDate.min = today;
    visitDate.addEventListener('change', loadServices);
  } else {
    dayPlanner.hidden = false;
    hourPlanner.hidden = true;
    hint.textContent = '';

    const checkIn = document.getElementById('checkIn');
    const checkOut = document.getElementById('checkOut');

    checkIn.value = today;
    checkOut.value = addDays(today, 1);
    checkIn.min = today;
    checkOut.min = addDays(today, 1);

    checkIn.addEventListener('change', () => {
      const minOut = addDays(checkIn.value, 1);
      checkOut.min = minOut;
      if (checkOut.value <= checkIn.value) checkOut.value = minOut;
      loadServices();
    });
    checkOut.addEventListener('change', loadServices);
  }
}

function getDates() {
  if (schedulingMode === 'hour') {
    const date = document.getElementById('visitDate').value;
    return { from: date, to: date };
  }
  return {
    from: document.getElementById('checkIn').value,
    to: document.getElementById('checkOut').value
  };
}

// ------------------------------------------------------------
// load services + group them by section
// ------------------------------------------------------------
async function loadServices() {
  const wrap = document.getElementById('sectionGroups');
  const { from, to } = getDates();

  if (!from || !to) {
    wrap.innerHTML = '<p class="list-note">Choose a date to see what\'s open.</p>';
    return;
  }

  if (schedulingMode !== 'hour' && countDays(from, to) < 1) {
    wrap.innerHTML = '<p class="list-note">Choose an arrival and departure date.</p>';
    return;
  }

  const days = schedulingMode === 'hour' ? 1 : countDays(from, to);

  if (schedulingMode === 'hour') {
    document.getElementById('nightCount').textContent = formatDate(from);
  } else {
    document.getElementById('nightCount').textContent = `${days} day${days === 1 ? '' : 's'}`;
  }

  wrap.innerHTML = '<p class="list-note">Checking the book&hellip;</p>';

  try {
    const [productsRes, availRes] = await Promise.all([
      fetch(`${API_URL}/api/public/products?company_id=${COMPANY_ID}&from=${from}&to=${to}`),
      fetch(`${API_URL}/api/public/availability?company_id=${COMPANY_ID}&from=${from}&days=${STRIP_DAYS}`)
    ]);

    const productsData = await productsRes.json();
    const products = productsData.products || [];
    currency = productsData.currency || currency;
    pricingMode = productsData.pricing_mode || pricingMode;

    const availData = availRes.ok ? await availRes.json() : { ranges: [], exclusions: [] };
    const bookedByProduct = buildBookedMap(availData.ranges || []);
    const excludedByProduct = buildExcludedMap(availData.exclusions || []);

    wrap.innerHTML = '';

    if (products.length === 0) {
      wrap.innerHTML = '<p class="list-note">No services listed yet.</p>';
      return;
    }

    // group by section — products with no section fall into "Services"
    const groups = new Map();
    products.forEach(p => {
      const key = p.section_name || 'Services';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });

    groups.forEach((items, sectionName) => {
      const section = document.createElement('div');
      section.className = 'section-group';
      section.innerHTML = `
        <div class="section-group-head">
          <h2>${escapeHtml(sectionName)}</h2>
          <p class="date-summary">${schedulingMode === 'hour' ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`}</p>
        </div>
        <div class="service-list"></div>
      `;
      const list = section.querySelector('.service-list');
      items.forEach(item => {
        list.appendChild(createServiceRow(
          item, from, to, days,
          bookedByProduct[item.id] || new Set(),
          excludedByProduct[item.id] || new Set()
        ));
      });
      wrap.appendChild(section);
    });

  } catch (err) {
    console.error(err);
    wrap.innerHTML = '<p class="list-note">Could not load services. Is the server running?</p>';
  }
}

// booked ranges -> a set of taken DAYS per product (Day-mode strip only)
function buildBookedMap(ranges) {
  const map = {};
  ranges.forEach(r => {
    if (!map[r.product_id]) map[r.product_id] = new Set();
    const cursor = new Date(r.start_date + 'T00:00:00');
    const end = new Date(r.end_date + 'T00:00:00');
    if (pricingMode === 'per_night') end.setDate(end.getDate() - 1);
    while (cursor <= end) {
      map[r.product_id].add(toISO(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  });
  return map;
}

function buildExcludedMap(exclusions) {
  const map = {};
  exclusions.forEach(e => {
    if (!map[e.product_id]) map[e.product_id] = new Set();
    const d = e.excluded_date;
    const dateStr = typeof d === 'string' ? d.slice(0, 10) : toISO(new Date(d));
    map[e.product_id].add(dateStr);
  });
  return map;
}

function createServiceRow(item, from, to, days, bookedDays, excludedDays) {
  const row = document.createElement('article');
  row.className = 'service' + (item.available ? '' : ' is-taken');

  const image = (item.images && item.images.length > 0)
    ? getImageUrl(item.images[0])
    : 'https://via.placeholder.com/600x400?text=No+Image';

  const rate = item.discount_price ?? item.price;
  const priceHtml = item.discount_price
    ? `<s class="was">${money(item.price)}</s> <strong>${money(item.discount_price)}</strong>`
    : `<strong>${money(rate)}</strong>`;

  let middleHtml;
  let actionHtml;

  if (schedulingMode === 'hour') {
    // Hours mode: this product may offer several times a day — the
    // actual list (with real per-date availability) is fetched on the
    // booking page, not here, since checking every product's slots for
    // every date on this list page would mean a lot of extra requests
    middleHtml = `
      <span class="slot-time">&#128337; Multiple times available</span>
    `;
    actionHtml = item.available
      ? `<button class="btn book-btn">Choose a time</button>
         <p class="total-line">${formatDate(from)} &middot; <strong>${money(rate)}</strong></p>`
      : `<p class="not-available"><em>Fully booked on this date</em></p>
         <p class="total-line muted">Try another date above</p>`;
  } else {
    const total = Number(rate) * days;
    const unit = pricingMode === 'per_night' ? 'night' : 'day';

    const strip = [];
    for (let i = 0; i < STRIP_DAYS; i++) {
      const day = addDays(from, i);
      const taken = bookedDays.has(day) || excludedDays.has(day);
      const inRange = i < days;
      const label = new Date(day + 'T00:00:00').getDate();
      strip.push(
        `<span class="day-cell${taken ? ' taken' : ' free'}${inRange ? ' in-range' : ''}" title="${formatDate(day)}${taken ? ' \u2014 not available' : ' \u2014 free'}">${label}</span>`
      );
    }

    middleHtml = `
      <div class="strip">
        <span class="strip-label">Next ${STRIP_DAYS} days</span>
        <div class="strip-cells">${strip.join('')}</div>
      </div>
    `;

    actionHtml = item.available
      ? `<button class="btn book-btn">Book now</button>
         <p class="total-line">${days} ${unit}${days === 1 ? '' : 's'} &middot; <strong>${money(total)}</strong></p>`
      : `<p class="not-available"><em>Not available during this date</em></p>
         <p class="total-line muted">Try the free days marked below</p>`;
  }

  row.innerHTML = `
    <div class="service-photo">
      <img src="${image}" alt="${escapeHtml(item.name)}">
      ${item.images && item.images.length > 1 ? `<span class="photo-count">${item.images.length} photos</span>` : ''}
    </div>
    <div class="service-body">
      <h3>${escapeHtml(item.name)}</h3>
      <p class="service-desc">${escapeHtml(item.description || '')}</p>
      <p class="rate">${priceHtml} <span class="per">${schedulingMode === 'hour' ? 'per visit' : 'per ' + (pricingMode === 'per_night' ? 'night' : 'day')}</span></p>
      ${middleHtml}
    </div>
    <div class="service-action">${actionHtml}</div>
  `;

  const bookBtn = row.querySelector('.book-btn');
  if (bookBtn) {
    bookBtn.addEventListener('click', () => {
      const params = schedulingMode === 'hour'
        ? `id=${item.id}&date=${from}`
        : `id=${item.id}&from=${from}&to=${to}`;
      window.open(`booking.html?${params}`, '_blank');
    });
  }

  return row;
}