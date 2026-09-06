// booking.js (Barber Retreat and Resort Co. — opens from a "Book" button)

if (!window.SITE) throw new Error('config.js must be loaded before booking.js');

const API_URL = window.SITE.API_URL;
const COMPANY_ID = window.SITE.COMPANY_ID;

const urlParams = new URLSearchParams(window.location.search);
const productId = urlParams.get('id');

// Day mode arrives with from/to; Hours mode arrives with a single date
let fromDate = urlParams.get('from');
let toDate = urlParams.get('to');
const urlDate = urlParams.get('date');

let currentItem = null;
let company = null;
let currency = 'RM';
let currentSlide = 0;
let slideCount = 0;

// Hours-mode state
let selectedDate = urlDate || null;
let selectedSlot = null;        // {id, start_time, end_time} the customer picked

function getImageUrl(url) {
  if (!url) return 'https://via.placeholder.com/800x500?text=No+Image';
  if (url.startsWith('http')) return url;
  return API_URL + url;
}

function toISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function timeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: m === 0 ? undefined : '2-digit' });
}

function countDays(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function money(value) {
  return `${currency} ${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function todayStr() { return toISO(new Date()); }

window.addEventListener('DOMContentLoaded', async () => {
  await loadCompany();
  await loadItem();

  document.getElementById('qrCloseBtn').addEventListener('click', () => {
    window.close();
  });
  document.getElementById('qrContactBtn').addEventListener('click', () => {
    const number = (company && company.whatsapp) ? company.whatsapp : window.SITE.FALLBACK_WHATSAPP;
    window.open(`https://wa.me/${number}`, '_blank');
  });
});

async function loadCompany() {
  try {
    const response = await fetch(`${API_URL}/api/public/company/${COMPANY_ID}`);
    if (response.ok) {
      company = await response.json();
      currency = company.currency || 'RM';
    }
  } catch (err) {
    console.error(err);
  }
}

async function loadItem() {
  const container = document.getElementById('detailContainer');

  if (!productId) {
    container.innerHTML = '<p class="list-note">No service selected.</p>';
    return;
  }

  try {
    const query = (fromDate && toDate) ? `?from=${fromDate}&to=${toDate}` : '';
    const response = await fetch(`${API_URL}/api/public/products/${productId}${query}`);
    const item = await response.json();

    if (!response.ok) {
      container.innerHTML = '<p class="list-note">Service not found.</p>';
      return;
    }

    currentItem = item;
    if (item.currency) currency = item.currency;

    if (item.scheduling_mode === 'hour') {
      if (!urlDate || urlDate < todayStr()) {
        container.innerHTML = `
          <div class="detail-body">
            <h2>${escapeHtml(item.name)}</h2>
            <p class="not-available"><em>No date was chosen</em></p>
            <p class="total-line muted">Please go back and choose a date on the previous page.</p>
            <div class="action-buttons"><button class="btn-cancel" id="cancelBtn">Close</button></div>
          </div>
        `;
        document.getElementById('cancelBtn').addEventListener('click', () => window.close());
        return;
      }
      selectedDate = urlDate;
      renderHourBooking(item);
    } else {
      renderDayBooking(item);
    }

  } catch (err) {
    console.error(err);
    container.innerHTML = '<p class="list-note">Could not load this service.</p>';
  }
}

// ------------------------------------------------------------
// HOURS MODE — date was already chosen on the homepage; here the
// customer only picks which time slot they want on that fixed date
// ------------------------------------------------------------
function renderHourBooking(item) {
  const container = document.getElementById('detailContainer');

  const images = (item.images && item.images.length > 0)
    ? item.images
    : ['https://via.placeholder.com/800x500?text=No+Image'];
  slideCount = images.length;
  currentSlide = 0;

  const slidesHtml = images
    .map(url => `<div class="slide"><img src="${getImageUrl(url)}" alt="${escapeHtml(item.name)}"></div>`)
    .join('');
  const dotsHtml = images
    .map((_, i) => `<span class="dot${i === 0 ? ' active' : ''}" data-index="${i}"></span>`)
    .join('');

  const rate = item.discount_price ?? item.price;

  container.innerHTML = `
    <div class="slider">
      ${slideCount > 1 ? '<button class="slide-btn prev" id="prevImgBtn" aria-label="Previous photo">&#10094;</button>' : ''}
      <div class="slide-window"><div class="slide-track" id="slideTrack">${slidesHtml}</div></div>
      ${slideCount > 1 ? '<button class="slide-btn next" id="nextImgBtn" aria-label="Next photo">&#10095;</button>' : ''}
    </div>
    ${slideCount > 1 ? `<div class="slide-dots" id="slideDots">${dotsHtml}</div>` : ''}

    <div class="detail-body">
      <h2>${escapeHtml(item.name)}</h2>
      <p class="room-desc">${escapeHtml(item.description || '')}</p>

      <div class="stay-card">
        <div class="stay-dates">
          <div>
            <span class="stay-label">Date</span>
            <span class="stay-value">${formatDate(selectedDate)}</span>
          </div>
        </div>
        <div class="stay-total">
          <span id="chosenSlotLabel">Choose a time below</span>
          <strong>${money(rate)}</strong>
        </div>
      </div>

      <div class="date-picker" id="slotPickerWrap">
        <span class="stay-label">Available times</span>
        <div class="slot-options" id="slotOptions">
          <p class="list-note">Checking times&hellip;</p>
        </div>
      </div>

      <div class="guest-form">
        <label for="customerName">Your name</label>
        <input type="text" id="customerName" placeholder="Full name">

        <label for="customerEmail">Email</label>
        <input type="email" id="customerEmail" placeholder="Where we send your confirmation">

        <label for="customerPhone">Phone</label>
        <input type="tel" id="customerPhone" placeholder="So we can reach you before your visit">
      </div>

      <div class="action-buttons">
        <button class="btn-cancel" id="cancelBtn">Cancel</button>
        <button class="btn-confirm" id="confirmBtn">Book now</button>
      </div>

      <div id="messageBox"></div>
    </div>
  `;

  setupSlider();

  document.getElementById('cancelBtn').addEventListener('click', () => window.close());
  document.getElementById('confirmBtn').addEventListener('click', () => submitBooking(item.id, selectedDate, selectedDate));

  updateHourSummary();
  loadSlotsForDate(item.id, selectedDate);
}

async function loadSlotsForDate(productId, date) {
  const wrap = document.getElementById('slotOptions');
  wrap.innerHTML = '<p class="list-note">Checking times&hellip;</p>';

  try {
    const res = await fetch(`${API_URL}/api/public/products/${productId}/time-slots?date=${date}`);
    const data = await res.json();

    if (!res.ok) {
      wrap.innerHTML = '<p class="list-note">Could not load times for this date.</p>';
      return;
    }

    const slots = data.slots || [];
    if (slots.length === 0) {
      wrap.innerHTML = '<p class="list-note">No times are set up for this service yet.</p>';
      return;
    }

    wrap.innerHTML = slots.map(s => `
      <button type="button" class="pick-cell slot-pick${s.available ? '' : ' is-blocked'}${
        selectedSlot && selectedSlot.start_time === s.start_time ? ' is-selected' : ''
      }" data-start="${s.start_time}" data-end="${s.end_time}" ${s.available ? '' : 'disabled'}>
        ${timeLabel(s.start_time)}&ndash;${timeLabel(s.end_time)}
      </button>
    `).join('');

    wrap.querySelectorAll('.slot-pick:not(.is-blocked)').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedSlot = { start_time: btn.dataset.start, end_time: btn.dataset.end };
        wrap.querySelectorAll('.slot-pick').forEach(b => b.classList.remove('is-selected'));
        btn.classList.add('is-selected');
        updateHourSummary();
      });
    });
  } catch (err) {
    console.error(err);
    wrap.innerHTML = '<p class="list-note">Could not connect to server.</p>';
  }
}

function updateHourSummary() {
  const slotEl = document.getElementById('chosenSlotLabel');
  if (slotEl) {
    slotEl.textContent = selectedSlot
      ? `${timeLabel(selectedSlot.start_time)} \u2013 ${timeLabel(selectedSlot.end_time)}`
      : 'Choose a time below';
  }

  const confirmBtn = document.getElementById('confirmBtn');
  if (confirmBtn) confirmBtn.disabled = !selectedSlot;
}

// ------------------------------------------------------------
// DAY MODE — same flow as the reference site: a date range chosen
// on the previous page, confirmed here
// ------------------------------------------------------------
function renderDayBooking(item) {
  const container = document.getElementById('detailContainer');

  const images = (item.images && item.images.length > 0)
    ? item.images
    : ['https://via.placeholder.com/800x500?text=No+Image'];
  slideCount = images.length;
  currentSlide = 0;

  const slidesHtml = images
    .map(url => `<div class="slide"><img src="${getImageUrl(url)}" alt="${escapeHtml(item.name)}"></div>`)
    .join('');
  const dotsHtml = images
    .map((_, i) => `<span class="dot${i === 0 ? ' active' : ''}" data-index="${i}"></span>`)
    .join('');

  const days = (fromDate && toDate) ? countDays(fromDate, toDate) : 0;
  const rate = item.discount_price ?? item.price;
  const total = Number(rate) * days;
  const unit = item.pricing_mode === 'per_night' ? 'night' : 'day';

  if (item.available === false) {
    container.innerHTML = `
      <div class="slider"><div class="slide-window"><div class="slide-track">${slidesHtml}</div></div></div>
      <div class="detail-body">
        <h2>${escapeHtml(item.name)}</h2>
        <p class="not-available"><em>Not available during this date</em></p>
        <div class="action-buttons"><button class="btn-cancel" id="cancelBtn">Close</button></div>
      </div>
    `;
    document.getElementById('cancelBtn').addEventListener('click', () => window.close());
    return;
  }

  container.innerHTML = `
    <div class="slider">
      ${slideCount > 1 ? '<button class="slide-btn prev" id="prevImgBtn" aria-label="Previous photo">&#10094;</button>' : ''}
      <div class="slide-window"><div class="slide-track" id="slideTrack">${slidesHtml}</div></div>
      ${slideCount > 1 ? '<button class="slide-btn next" id="nextImgBtn" aria-label="Next photo">&#10095;</button>' : ''}
    </div>
    ${slideCount > 1 ? `<div class="slide-dots" id="slideDots">${dotsHtml}</div>` : ''}

    <div class="detail-body">
      <h2>${escapeHtml(item.name)}</h2>
      <p class="room-desc">${escapeHtml(item.description || '')}</p>

      <div class="stay-card">
        <div class="stay-dates">
          <div>
            <span class="stay-label">Arrival</span>
            <span class="stay-value">${fromDate ? formatDate(fromDate) : '\u2014'}</span>
          </div>
          <div class="stay-sep" aria-hidden="true">&rarr;</div>
          <div>
            <span class="stay-label">Departure</span>
            <span class="stay-value">${toDate ? formatDate(toDate) : '\u2014'}</span>
          </div>
        </div>
        <div class="stay-total">
          <span>${money(rate)} &times; ${days} ${unit}${days === 1 ? '' : 's'}</span>
          <strong>${money(total)}</strong>
        </div>
      </div>

      <div class="guest-form">
        <label for="customerName">Your name</label>
        <input type="text" id="customerName" placeholder="Full name">

        <label for="customerEmail">Email</label>
        <input type="email" id="customerEmail" placeholder="Where we send your confirmation">

        <label for="customerPhone">Phone</label>
        <input type="tel" id="customerPhone" placeholder="So we can reach you on the day">
      </div>

      <div class="action-buttons">
        <button class="btn-cancel" id="cancelBtn">Cancel</button>
        <button class="btn-confirm" id="confirmBtn">Book now</button>
      </div>

      <div id="messageBox"></div>
    </div>
  `;

  setupSlider();
  document.getElementById('cancelBtn').addEventListener('click', () => window.close());
  document.getElementById('confirmBtn').addEventListener('click', () => submitBooking(item.id, fromDate, toDate));
}

// ------------------------------------------------------------
// photo slider (shared by both modes)
// ------------------------------------------------------------
function setupSlider() {
  const prevBtn = document.getElementById('prevImgBtn');
  const nextBtn = document.getElementById('nextImgBtn');

  if (prevBtn) prevBtn.addEventListener('click', () => goToSlide(currentSlide - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => goToSlide(currentSlide + 1));

  document.querySelectorAll('#slideDots .dot').forEach(dot => {
    dot.addEventListener('click', () => goToSlide(Number(dot.dataset.index)));
  });

  const track = document.getElementById('slideTrack');
  let touchStartX = 0;

  if (track) {
    track.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; });
    track.addEventListener('touchend', e => {
      const diff = touchStartX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 40) goToSlide(currentSlide + (diff > 0 ? 1 : -1));
    });
  }
}

function goToSlide(index) {
  if (index < 0) index = slideCount - 1;
  if (index >= slideCount) index = 0;
  currentSlide = index;

  const track = document.getElementById('slideTrack');
  if (track) track.style.transform = `translateX(-${currentSlide * 100}%)`;

  document.querySelectorAll('#slideDots .dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === currentSlide);
  });
}

// ------------------------------------------------------------
// booking -> QR payment popup (shared by both modes)
// ------------------------------------------------------------
async function submitBooking(itemId, startDate, endDate) {
  const messageBox = document.getElementById('messageBox');
  const confirmBtn = document.getElementById('confirmBtn');

  const customerName = document.getElementById('customerName').value.trim();
  const customerEmail = document.getElementById('customerEmail').value.trim();
  const customerPhone = document.getElementById('customerPhone').value.trim();

  if (!customerName || !customerEmail) {
    messageBox.innerHTML = '<div class="message-box message-error">Add your name and email so we can confirm your booking.</div>';
    return;
  }

  if (!startDate || !endDate) {
    messageBox.innerHTML = '<div class="message-box message-error">Choose a date first.</div>';
    return;
  }

  if (currentItem && currentItem.scheduling_mode === 'hour' && !selectedSlot) {
    messageBox.innerHTML = '<div class="message-box message-error">Choose a time first.</div>';
    return;
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Booking...';

  try {
    const response = await fetch(`${API_URL}/api/public/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: itemId,
        company_id: COMPANY_ID,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        start_date: startDate,
        end_date: endDate,
        ...(selectedSlot ? { start_time: selectedSlot.start_time, end_time: selectedSlot.end_time } : {})
      })
    });

    const data = await response.json();

    if (response.ok) {
      messageBox.innerHTML = '';
      showQrModal();
    } else {
      messageBox.innerHTML = `<div class="message-box message-error">${data.error || 'Something went wrong.'}</div>`;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Book now';
    }

  } catch (err) {
    console.error(err);
    messageBox.innerHTML = '<div class="message-box message-error">Could not connect to server.</div>';
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Book now';
  }
}

function showQrModal() {
  const qrImage = document.getElementById('qrImage');
  qrImage.src = (company && company.qr_code_url)
    ? getImageUrl(company.qr_code_url)
    : 'https://via.placeholder.com/300x300?text=Upload+QR+in+dashboard';
  document.getElementById('qrModal').classList.remove('hidden');
}