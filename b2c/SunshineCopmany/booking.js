// booking.js (Sunshine Travel Co. — opens from the "Checkout" button)

// settings come from config.js, which must load first
if (!window.SITE) throw new Error('config.js must be loaded before booking.js');

const API_URL = window.SITE.API_URL;
const COMPANY_ID = window.SITE.COMPANY_ID;

// read the product and the dates the customer picked on the landing page
const urlParams = new URLSearchParams(window.location.search);
const productId = urlParams.get('id');
const fromDate = urlParams.get('from');
const toDate = urlParams.get('to');

let currentProduct = null;
let company = null;
let pricingMode = 'per_day';
let currency = '$';
let currentSlide = 0;
let slideCount = 0;

function getImageUrl(url) {
  if (!url) return 'https://via.placeholder.com/800x350?text=No+Image';
  if (url.startsWith('http')) return url;
  return API_URL + url;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function countDays(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.round((b - a) / 86400000) + 1;
}

// mirrors durationText()/pricing_mode handling in the B2B dashboard,
// so a homestay-style company reads "nights" and a tour company "days"
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

function timeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: m === 0 ? undefined : '2-digit' }).replace(/\s/g, '');
}

window.addEventListener('DOMContentLoaded', async () => {
  await loadCompany();
  loadProductDetail();

  document.getElementById('qrCloseBtn').addEventListener('click', () => {
    document.getElementById('qrModal').classList.add('hidden');
  });

  document.getElementById('qrContactBtn').addEventListener('click', () => {
    // whatsapp number comes from the company's settings in the B2B dashboard
    const number = (company && company.whatsapp) ? company.whatsapp : window.SITE.FALLBACK_WHATSAPP;
    window.open(`https://wa.me/${number}`, '_blank');
  });
});

// the company record holds the payment QR, the contact number, and the
// display settings (pricing_mode, currency) that keep this page in sync
// with whatever the operator configured in the B2B dashboard.
// this is a PUBLIC lookup — it only returns fields safe to show a
// customer (see /api/public/company/:id in server.js).
async function loadCompany() {
  try {
    const response = await fetch(`${API_URL}/api/public/company/${COMPANY_ID}`);
    if (response.ok) {
      company = await response.json();
      pricingMode = company.pricing_mode || 'per_day';
      currency = company.currency || '$';
    }
  } catch (err) {
    console.error(err);
  }
}

async function loadProductDetail() {
  const container = document.getElementById('detailContainer');

  if (!productId) {
    container.innerHTML = '<p class="grid-note">No activity selected.</p>';
    return;
  }

  try {
    const query = (fromDate && toDate) ? `?from=${fromDate}&to=${toDate}` : '';
    const response = await fetch(`${API_URL}/api/public/products/${productId}${query}`);
    const product = await response.json();

    if (!response.ok) {
      container.innerHTML = '<p class="grid-note">Activity not found.</p>';
      return;
    }

    currentProduct = product;
    renderDetail(product);

  } catch (err) {
    console.error(err);
    container.innerHTML = '<p class="grid-note">Could not load activity details.</p>';
  }
}

function renderDetail(product) {
  const container = document.getElementById('detailContainer');

  const images = (product.images && product.images.length > 0)
    ? product.images
    : ['https://via.placeholder.com/800x350?text=No+Image'];

  slideCount = images.length;
  currentSlide = 0;

  const slidesHtml = images
    .map(url => `<div class="slide"><img src="${getImageUrl(url)}" alt="${escapeHtml(product.name)}"></div>`)
    .join('');

  const dotsHtml = images
    .map((_, i) => `<span class="dot${i === 0 ? ' active' : ''}" data-index="${i}"></span>`)
    .join('');

  const priceText = product.discount_price
    ? `<span class="original-price">${money(product.price)}</span> <span class="discount-price">${money(product.discount_price)}</span> <span class="per-day">per ${pricingMode === 'per_night' ? 'night' : 'day'}</span>`
    : `<span class="normal-price">${money(product.price)}</span> <span class="per-day">per ${pricingMode === 'per_night' ? 'night' : 'day'}</span>`;

  const hoursHtml = (product.start_time && product.end_time)
    ? `<p class="hours-note">Runs ${timeLabel(product.start_time)} &ndash; ${timeLabel(product.end_time)}</p>`
    : '';

  const count = (fromDate && toDate) ? durationCount(fromDate, toDate) : 1;
  const unitPrice = product.discount_price ?? product.price;
  const total = Number(unitPrice) * count;

  const dateLine = (fromDate && toDate)
    ? (fromDate === toDate
        ? formatDate(fromDate)
        : `${formatDate(fromDate)} &rarr; ${formatDate(toDate)}`)
    : 'No dates selected';

  // if these dates got taken between the landing page and here, stop the flow
  if (product.available === false) {
    container.innerHTML = `
      <div class="detail-main">
        <div class="detail-images-slider">
          <div class="slide-window"><div class="slide-track">${slidesHtml}</div></div>
        </div>
        <div class="detail-body">
          <span class="mark">Sunshine Travel Co.</span>
          <h2>${escapeHtml(product.name)}</h2>
          ${hoursHtml}
        </div>
      </div>
      <div class="ledger">
        <h3>Your dates</h3>
        <div class="l-row"><span>Selected</span><span>${dateLine}</span></div>
        <p class="not-available" style="margin-top:0.75rem;"><em>Fully booked during this date</em></p>
        <div class="action-buttons">
          <button class="btn-cancel" id="cancelBtn">Close</button>
        </div>
      </div>
    `;
    document.getElementById('cancelBtn').addEventListener('click', () => window.close());
    return;
  }

  container.innerHTML = `
    <div class="detail-main">
      <div class="detail-images-slider">
        ${slideCount > 1 ? '<button class="slide-btn prev" id="prevImgBtn" aria-label="Previous image">&#10094;</button>' : ''}
        <div class="slide-window">
          <div class="slide-track" id="slideTrack">${slidesHtml}</div>
        </div>
        ${slideCount > 1 ? '<button class="slide-btn next" id="nextImgBtn" aria-label="Next image">&#10095;</button>' : ''}
      </div>
      ${slideCount > 1 ? `<div class="slide-dots" id="slideDots">${dotsHtml}</div>` : ''}

      <div class="detail-body">
        <span class="mark">Sunshine Travel Co.</span>
        <h2>${escapeHtml(product.name)}</h2>
        <div class="price-row">${priceText}</div>
        ${hoursHtml}
        <p class="desc">${escapeHtml(product.description || '')}</p>
      </div>
    </div>

    <div class="ledger">
      <h3>Reservation summary</h3>
      <div class="l-row"><span>Dates</span><span>${dateLine}</span></div>
      <div class="l-row"><span>Duration</span><span>${count} ${unitLabel(count)}</span></div>
      <div class="l-row"><span>Rate</span><span>${money(unitPrice)} / ${pricingMode === 'per_night' ? 'night' : 'day'}</span></div>
      <div class="l-total"><span>Total due</span><strong>${money(total)}</strong></div>

      <div class="customer-form" style="margin-top:1.4rem;">
        <input type="text" id="customerName" placeholder="Your full name" required>
        <input type="email" id="customerEmail" placeholder="Your email" required>
        <input type="tel" id="customerPhone" placeholder="Your phone number">
      </div>

      <div class="action-buttons">
        <button class="btn-cancel" id="cancelBtn">Cancel</button>
        <button class="btn-confirm" id="confirmBtn">Book now</button>
      </div>

      <div id="messageBox"></div>
      <p class="l-note">You'll get a QR code to pay on the next step. Once payment is received, we'll email your confirmation within 24 hours.</p>
    </div>
  `;

  setupSlider();

  document.getElementById('cancelBtn').addEventListener('click', () => {
    window.close();
    // Some browsers only allow window.close() on tabs opened by JS, which is
    // the case here. If it doesn't close, that's a browser setting, not a bug.
  });

  document.getElementById('confirmBtn').addEventListener('click', () => {
    submitBooking(product.id);
  });
}

// ------------------------------------------------------------
// image slider
// ------------------------------------------------------------
function setupSlider() {
  const prevBtn = document.getElementById('prevImgBtn');
  const nextBtn = document.getElementById('nextImgBtn');

  if (prevBtn) prevBtn.addEventListener('click', () => goToSlide(currentSlide - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => goToSlide(currentSlide + 1));

  document.querySelectorAll('#slideDots .dot').forEach(dot => {
    dot.addEventListener('click', () => goToSlide(Number(dot.dataset.index)));
  });

  // swipe support for phones
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
// booking -> QR payment popup
// ------------------------------------------------------------
async function submitBooking(productId) {
  const messageBox = document.getElementById('messageBox');
  const confirmBtn = document.getElementById('confirmBtn');

  const customerName = document.getElementById('customerName').value.trim();
  const customerEmail = document.getElementById('customerEmail').value.trim();
  const customerPhone = document.getElementById('customerPhone').value.trim();

  if (!customerName || !customerEmail) {
    messageBox.innerHTML = '<div class="message-box message-error">Please fill in your name and email.</div>';
    return;
  }

  if (!fromDate || !toDate) {
    messageBox.innerHTML = '<div class="message-box message-error">Go back and choose your dates first.</div>';
    return;
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Booking...';

  try {
    // COMPANY_ID is included here to match the shape of the API, but the
    // server ignores it — it always derives the real owner from the
    // product row, so this request can never be pointed at another company.
    const response = await fetch(`${API_URL}/api/public/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: productId,
        company_id: COMPANY_ID,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        start_date: fromDate,
        end_date: toDate
      })
    });

    const data = await response.json();

    if (response.ok) {
      messageBox.innerHTML = '';
      showQrModal();
    } else {
      messageBox.innerHTML = `<div class="message-box message-error">${escapeHtml(data.error) || 'Something went wrong.'}</div>`;
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