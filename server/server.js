// ============================================================
// server.js
//
// Route naming carries the security model, so it can be audited
// at a glance:
//
//   /api/public/*   open to anyone. Only ever returns data that is
//                   safe on a public web page.
//   /api/me/*       requires a valid token. The company is read from
//                   the TOKEN, never from the URL or body, so one
//                   client can never address another's data.
//
// If a route is not under /api/public it must be behind requireAuth.
// ============================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Refuse to boot without a real secret. A default secret in source
// would let anyone mint their own valid tokens.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('\nJWT_SECRET missing or too short. Put a long random value in backend/.env');
  console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
  process.exit(1);
}

const TOKEN_TTL = process.env.TOKEN_TTL || '8h';

// ------------------------------------------------------------
// EMAIL — sends the booking receipt from ssztraining1@gmail.com
// when a company marks a booking's payment as received.
//
// Requires a Gmail "App Password" (not the normal account password —
// Gmail blocks plain password SMTP login). Set these in backend/.env:
//   GMAIL_USER=ssztraining1@gmail.com
//   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
// Generate an app password at: https://myaccount.google.com/apppasswords
// (requires 2-Step Verification to be turned on for that Gmail account)
// ------------------------------------------------------------

const GMAIL_USER = process.env.GMAIL_USER || 'ssztraining1@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

let mailer = null;
if (GMAIL_APP_PASSWORD) {
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });
} else {
  console.warn('GMAIL_APP_PASSWORD not set in .env — booking receipt emails are disabled.');
}

// ------------------------------------------------------------
// BASELINE MIDDLEWARE
// ------------------------------------------------------------

app.set('trust proxy', 1);
app.disable('x-powered-by');

// security headers. crossOriginResourcePolicy is relaxed so the B2C
// sites on another port can still display uploaded images.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Only our own sites may call this API from a browser.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // allow curl/postman (no Origin) and anything on the allowlist
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Origin not allowed'));
  },
  credentials: true
}));

// cap body size so a huge payload can't exhaust memory
app.use(express.json({ limit: '100kb' }));

// general throttle across the whole API
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again shortly.' }
}));

// tighter limits where abuse is cheap and damaging
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many bookings from this connection. Try again later.' }
});


// ------------------------------------------------------------
// UPLOADS
// Filenames are random, so a caller can never choose a path,
// overwrite another file, or smuggle in a traversal sequence.
// ------------------------------------------------------------

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype) || !ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed'));
    }
    cb(null, true);
  }
});

// nosniff stops a file being interpreted as script even if one slipped through
app.use('/uploads', express.static(uploadDir, {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
  }
}));


// ------------------------------------------------------------
// AUTH
// ------------------------------------------------------------

function signToken(company) {
  return jwt.sign(
    { sub: company.id, tv: company.token_version },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Reads the caller's company from the token and nowhere else.
// token_version lets a password change invalidate old tokens.
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    const [rows] = await db.query(
      `SELECT id, company_name, email, phone, address, whatsapp,
              qr_code_url, pricing_mode, currency, scheduling_mode, token_version
       FROM companies WHERE id = ?`,
      [payload.sub]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Please log in' });

    if (rows[0].token_version !== payload.tv) {
      return res.status(401).json({ error: 'Session ended. Please log in again.' });
    }

    req.company = rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ------------------------------------------------------------
// PLATFORM ADMIN AUTH
//
// Entirely separate from company auth above — different table
// (platform_admins), different token scope, checked by a different
// middleware. A company token can never pass requirePlatformAdmin,
// and a platform admin token can never pass requireAuth, even though
// both are signed with the same JWT_SECRET.
// ------------------------------------------------------------

function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin.id, scope: 'platform_admin' },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

async function requirePlatformAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    if (payload.scope !== 'platform_admin') {
      return res.status(401).json({ error: 'Please log in' });
    }

    const [rows] = await db.query('SELECT id, email FROM platform_admins WHERE id = ?', [payload.sub]);
    if (rows.length === 0) return res.status(401).json({ error: 'Please log in' });

    req.admin = rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}


// ------------------------------------------------------------
// VALIDATION HELPERS
// ------------------------------------------------------------

const isValidDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(new Date(s + 'T00:00:00').getTime());

const isValidEmail = s => typeof s === 'string' && s.length <= 255
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// accepts "HH:MM" or "HH:MM:SS", 24-hour
const isValidTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s);

// normalizes to "HH:MM:SS", falling back when absent/invalid
function parseTime(value, fallback) {
  if (!isValidTime(value)) return fallback;
  return value.length === 5 ? value + ':00' : value;
}

// 0-9 index into the dashboard's fixed 10-colour palette, or null to
// let the dashboard assign a colour automatically
function parseColorIndex(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : null;
}

// "HH:MM:SS" strings compare correctly with plain string comparison, so no
// date parsing is needed here — just standard interval-overlap math
function timeRangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// used when adding/editing a time slot in Hours setting — a slot must not
// overlap any OTHER slot belonging to ANY product in the company, since
// they'd otherwise both claim the same moment (e.g. two services on one
// barber's chair at once). Unlike the old per-product check this replaces,
// products no longer collide just by existing — only actual slots can.
async function findSlotCollision(companyId, startTime, endTime, excludeSlotId) {
  const [rows] = await db.query(
    `SELECT product_time_slots.id, product_time_slots.start_time, product_time_slots.end_time,
            products.name AS product_name
     FROM product_time_slots
     JOIN products ON products.id = product_time_slots.product_id
     WHERE products.company_id = ? AND product_time_slots.id <> ?`,
    [companyId, excludeSlotId || 0]
  );
  return rows.find(s => timeRangesOverlap(startTime, endTime, s.start_time, s.end_time)) || null;
}

// true if any manually-blocked date for this product falls within [from, to]
// (inclusive) — used to keep a booking off a date the company has excluded,
// regardless of what else is or isn't already booked around it
async function hasExcludedDateInRange(productId, from, to) {
  const [rows] = await db.query(
    `SELECT 1 FROM product_date_exclusions
     WHERE product_id = ? AND excluded_date BETWEEN ? AND ? LIMIT 1`,
    [productId, from, to]
  );
  return rows.length > 0;
}

// Hours mode: a product is bookable on a date if it has at least one
// slot that isn't excluded and isn't already taken by another booking —
// unlike Day mode, one booking no longer blocks the whole product.
async function hourSlotsAvailableOnDate(productId, date) {
  const [slots] = await db.query(
    'SELECT start_time FROM product_time_slots WHERE product_id = ?',
    [productId]
  );
  if (slots.length === 0) return false;

  if (await hasExcludedDateInRange(productId, date, date)) return false;

  const [bookedRows] = await db.query(
    `SELECT start_time FROM bookings
     WHERE product_id = ? AND status <> 'cancelled' AND start_date = ? AND start_time IS NOT NULL`,
    [productId, date]
  );
  const bookedTimes = new Set(bookedRows.map(r => r.start_time));

  return slots.some(s => !bookedTimes.has(s.start_time));
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function parseMoney(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) return null;
  return Number(n.toFixed(2));
}

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// per_day blocks the end date, per_night frees the check-out day
const overlapClause = mode => mode === 'per_night'
  ? 'start_date < ? AND end_date > ?'
  : 'start_date <= ? AND end_date >= ?';

function countUnits(from, to, mode) {
  const days = Math.round(
    (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000
  );
  return mode === 'per_night' ? days : days + 1;
}

// stays must be sane: not backwards, not absurdly long
function checkRange(from, to, mode) {
  if (!isValidDate(from) || !isValidDate(to)) return 'Please choose your dates';
  const units = countUnits(from, to, mode);
  if (units < 1) {
    return mode === 'per_night'
      ? 'Check-out must be at least one night after check-in'
      : 'The end date cannot be before the start date';
  }
  if (units > 90) return 'That range is too long. Please contact us directly.';
  return null;
}

async function getCompanySettings(companyId) {
  const [rows] = await db.query(
    'SELECT pricing_mode, currency, scheduling_mode FROM companies WHERE id = ?',
    [companyId]
  );
  return rows[0] || null;
}

// ------------------------------------------------------------
// RECEIPT EMAIL
// ------------------------------------------------------------

function formatMoney(value, currency) {
  const amount = Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'RM' ? `RM ${amount}` : `${currency}${amount}`;
}

function formatReceiptDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatReceiptTime(hhmmss) {
  if (!hhmmss) return '';
  const [h, m] = hhmmss.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: m === 0 ? undefined : '2-digit' });
}

// Hours mode: "Time — 9:00 AM – 9:30 AM" (the specific slot booked).
// Day mode: "Duration — 3 nights" (or days), same as before.
function durationRowForEmail(b) {
  if (b.scheduling_mode === 'hour' && b.start_time && b.end_time) {
    return {
      label: 'Time',
      value: `${formatReceiptTime(b.start_time)} \u2013 ${formatReceiptTime(b.end_time)}`
    };
  }
  const unit = b.pricing_mode === 'per_night' ? 'night' : 'day';
  const units = countUnits(b.start_date, b.end_date, b.pricing_mode);
  return { label: 'Duration', value: `${units} ${unit}${units === 1 ? '' : 's'}` };
}

// booking here is the joined row: bookings.* plus product_name,
// company_name, pricing_mode, currency (see the query in the
// booking-status route)
function buildReceiptHtml(b) {
  const dateRange = b.start_date === b.end_date
    ? formatReceiptDate(b.start_date)
    : `${formatReceiptDate(b.start_date)} &ndash; ${formatReceiptDate(b.end_date)}`;
  const duration = durationRowForEmail(b);

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#14192B;">
      <h2 style="margin:0 0 2px;">Booking Receipt</h2>
      <p style="color:#64748B;margin:0 0 18px;">${b.company_name}</p>
      <hr style="border:none;border-top:1px solid #DAD5C6;margin:0 0 18px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:4px 0;color:#64748B;">Receipt #</td><td style="padding:4px 0;text-align:right;">${b.id}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">Guest name</td><td style="padding:4px 0;text-align:right;">${b.customer_name}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">Product</td><td style="padding:4px 0;text-align:right;">${b.product_name}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">Dates</td><td style="padding:4px 0;text-align:right;">${dateRange}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">${duration.label}</td><td style="padding:4px 0;text-align:right;">${duration.value}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">Amount paid</td><td style="padding:4px 0;text-align:right;font-weight:700;">${formatMoney(b.amount, b.currency)}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">Status</td><td style="padding:4px 0;text-align:right;color:#2E9E6D;font-weight:700;">Confirmed</td></tr>
      </table>
      <hr style="border:none;border-top:1px solid #DAD5C6;margin:18px 0;">
      <p style="color:#64748B;font-size:12px;margin:0;">
        Thank you for booking with ${b.company_name}. This receipt confirms your payment has been received.
        If you have any questions, please contact us directly.
      </p>
    </div>
  `;
}

// fire-and-forget: a failed email should never fail the booking update
// that triggered it, so every error is caught and only logged
async function sendReceiptEmail(b) {
  if (!mailer) {
    console.warn(`Skipped receipt email for booking #${b.id} — mailer not configured.`);
    return;
  }
  try {
    await mailer.sendMail({
      from: `"${b.company_name}" <${GMAIL_USER}>`,
      to: b.customer_email,
      subject: `Your booking receipt \u2014 ${b.product_name}`,
      html: `<p>Here's the receipt of your booking!</p>${buildReceiptHtml(b)}`
    });
  } catch (err) {
    console.error(`Could not send receipt email for booking #${b.id}:`, err);
  }
}

// used specifically for a booking cancelled via "Cancel payment" (i.e. one
// that had already been confirmed) — never for "Payment error" cancellations
const PAYMENT_ERROR_REASON = 'Payment error';

function dateRangeForEmail(b) {
  return b.start_date === b.end_date
    ? formatReceiptDate(b.start_date)
    : `${formatReceiptDate(b.start_date)} \u2013 ${formatReceiptDate(b.end_date)}`;
}

function buildCancellationHtml(b) {
  const duration = durationRowForEmail(b);
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#14192B;">
      <h2 style="margin:0 0 2px;">Booking Cancelled</h2>
      <p style="color:#64748B;margin:0 0 18px;">${b.company_name}</p>
      <hr style="border:none;border-top:1px solid #DAD5C6;margin:0 0 18px;">
      <p>Hi ${b.customer_name},</p>
      <p>Sorry, we have to cancel your booking due to <strong>${b.cancel_reason}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
        <tr><td style="padding:4px 0;color:#64748B;">Product</td><td style="padding:4px 0;text-align:right;">${b.product_name}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">Dates</td><td style="padding:4px 0;text-align:right;">${dateRangeForEmail(b)}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">${duration.label}</td><td style="padding:4px 0;text-align:right;">${duration.value}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">Refund amount</td><td style="padding:4px 0;text-align:right;font-weight:700;">${formatMoney(b.amount, b.currency)}</td></tr>
      </table>
      <p style="color:#64748B;font-size:12px;margin:0;">
        If you have any questions about your refund, please contact ${b.company_name} directly.
      </p>
    </div>
  `;
}

function buildPaymentErrorHtml(b, companyPhone) {
  const duration = durationRowForEmail(b);
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#14192B;">
      <h2 style="margin:0 0 2px;">We Couldn't Process Your Payment</h2>
      <p style="color:#64748B;margin:0 0 18px;">${b.company_name}</p>
      <hr style="border:none;border-top:1px solid #DAD5C6;margin:0 0 18px;">
      <p>Hi ${b.customer_name},</p>
      <p>Please contact us on <strong>${companyPhone || 'our contact number'}</strong> as we were unable to receive your payment for the following booking:</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
        <tr><td style="padding:4px 0;color:#64748B;">Product</td><td style="padding:4px 0;text-align:right;">${b.product_name}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">Dates</td><td style="padding:4px 0;text-align:right;">${dateRangeForEmail(b)}</td></tr>
        <tr><td style="padding:4px 0;color:#64748B;">${duration.label}</td><td style="padding:4px 0;text-align:right;">${duration.value}</td></tr>
      </table>
    </div>
  `;
}

async function sendCancellationEmail(b) {
  if (!mailer) {
    console.warn(`Skipped cancellation email for booking #${b.id} — mailer not configured.`);
    return;
  }
  try {
    await mailer.sendMail({
      from: `"${b.company_name}" <${GMAIL_USER}>`,
      to: b.customer_email,
      subject: `Your booking has been cancelled \u2014 ${b.product_name}`,
      html: buildCancellationHtml(b)
    });
  } catch (err) {
    console.error(`Could not send cancellation email for booking #${b.id}:`, err);
  }
}

async function sendPaymentErrorEmail(b, companyPhone) {
  if (!mailer) {
    console.warn(`Skipped payment-error email for booking #${b.id} — mailer not configured.`);
    return;
  }
  try {
    await mailer.sendMail({
      from: `"${b.company_name}" <${GMAIL_USER}>`,
      to: b.customer_email,
      subject: `Action needed \u2014 payment issue with your booking`,
      html: buildPaymentErrorHtml(b, companyPhone)
    });
  } catch (err) {
    console.error(`Could not send payment-error email for booking #${b.id}:`, err);
  }
}

// used by the /api/me product and booking routes so a caller can only
// ever touch rows belonging to their own company
async function ownsProduct(companyId, productId) {
  const [rows] = await db.query(
    'SELECT id FROM products WHERE id = ? AND company_id = ?',
    [productId, companyId]
  );
  return rows.length > 0;
}


// ============================================================
// AUTH ROUTES
// ============================================================

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const ip = req.ip;
  const email = cleanText(req.body.email, 255);
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Enter your email and password' });
    }

    const [rows] = await db.query('SELECT * FROM companies WHERE email = ?', [email]);
    const company = rows[0];

    // Compare against a dummy hash when the account is unknown, so the
    // response takes the same time either way and can't be used to
    // discover which emails exist.
    const hash = company
      ? company.password_hash
      : '$2b$12$1o8Mb1/5/Lvg21/NQu0JXucIJbMk4RqE84lAAsxJ0fpq7T.pfVoM.';

    const ok = await bcrypt.compare(password, hash);

    await db.query(
      'INSERT INTO login_attempts (email, ip, successful) VALUES (?, ?, ?)',
      [email, ip, company && ok ? 1 : 0]
    );

    // one message for both cases — never reveal which half was wrong
    if (!company || !ok) {
      return res.status(401).json({ error: 'Wrong email or password' });
    }

    res.json({
      token: signToken(company),
      company: {
        id: company.id,
        company_name: company.company_name,
        email: company.email,
        phone: company.phone,
        address: company.address,
        whatsapp: company.whatsapp,
        qr_code_url: company.qr_code_url,
        pricing_mode: company.pricing_mode,
        scheduling_mode: company.scheduling_mode,
        currency: company.currency
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const ip = req.ip;
  const email = cleanText(req.body.email, 255);
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Enter your email and password' });
    }

    const [rows] = await db.query('SELECT * FROM platform_admins WHERE email = ?', [email]);
    const admin = rows[0];

    const hash = admin
      ? admin.password_hash
      : '$2b$12$1o8Mb1/5/Lvg21/NQu0JXucIJbMk4RqE84lAAsxJ0fpq7T.pfVoM.';

    const ok = await bcrypt.compare(password, hash);

    await db.query(
      'INSERT INTO login_attempts (email, ip, successful) VALUES (?, ?, ?)',
      [email, ip, admin && ok ? 1 : 0]
    );

    if (!admin || !ok) {
      return res.status(401).json({ error: 'Wrong email or password' });
    }

    res.json({
      token: signAdminToken(admin),
      admin: { id: admin.id, email: admin.email }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ============================================================
// ADMIN PORTAL ROUTES  (manages the company list itself)
// Everything below requires a platform_admin token — never a
// company's own token, even though they share a JWT_SECRET.
// ============================================================

app.use('/api/admin', requirePlatformAdmin);

app.get('/api/admin/companies', async (req, res) => {
  try {
    const [companies] = await db.query(
      `SELECT id, company_name, email, phone, address, whatsapp,
              pricing_mode, scheduling_mode, currency, created_at
       FROM companies ORDER BY created_at DESC`
    );
    res.json({ companies });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/companies', async (req, res) => {
  try {
    const companyName = cleanText(req.body.company_name, 255);
    const email = cleanText(req.body.email, 255);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const phone = cleanText(req.body.phone, 50);
    const address = cleanText(req.body.address, 255);
    const whatsapp = cleanText(req.body.whatsapp, 50);
    const pricingMode = ['per_day', 'per_night'].includes(req.body.pricing_mode) ? req.body.pricing_mode : 'per_day';
    const schedulingMode = ['day', 'hour'].includes(req.body.scheduling_mode) ? req.body.scheduling_mode : 'day';
    const currency = cleanText(req.body.currency, 5) || '$';

    if (!companyName) return res.status(400).json({ error: 'Company name is required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (whatsapp && !/^\d{6,20}$/.test(whatsapp)) {
      return res.status(400).json({ error: 'WhatsApp number should be digits only' });
    }

    const [existing] = await db.query('SELECT id FROM companies WHERE email = ?', [email]);
    if (existing.length > 0) return res.status(409).json({ error: 'That email is already in use' });

    // hashed here, server-side — the admin portal never stores or sends
    // a plain password anywhere except this one request
    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await db.query(
      `INSERT INTO companies (company_name, email, password_hash, phone, address, whatsapp, pricing_mode, scheduling_mode, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyName, email, passwordHash, phone, address, whatsapp, pricingMode, schedulingMode, currency]
    );

    res.json({ message: 'Company created', id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/companies/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad company id' });

    const [existingRows] = await db.query('SELECT password_hash FROM companies WHERE id = ?', [id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Company not found' });

    const companyName = cleanText(req.body.company_name, 255);
    const email = cleanText(req.body.email, 255);
    const phone = cleanText(req.body.phone, 50);
    const address = cleanText(req.body.address, 255);
    const whatsapp = cleanText(req.body.whatsapp, 50);
    const pricingMode = ['per_day', 'per_night'].includes(req.body.pricing_mode) ? req.body.pricing_mode : 'per_day';
    const schedulingMode = ['day', 'hour'].includes(req.body.scheduling_mode) ? req.body.scheduling_mode : 'day';
    const currency = cleanText(req.body.currency, 5) || '$';
    const password = typeof req.body.password === 'string' ? req.body.password.trim() : '';

    if (!companyName) return res.status(400).json({ error: 'Company name is required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (whatsapp && !/^\d{6,20}$/.test(whatsapp)) {
      return res.status(400).json({ error: 'WhatsApp number should be digits only' });
    }
    if (password && password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const [taken] = await db.query('SELECT id FROM companies WHERE email = ? AND id <> ?', [email, id]);
    if (taken.length > 0) return res.status(409).json({ error: 'That email is already in use' });

    // leave the password untouched unless a new one was actually typed
    const passwordHash = password ? await bcrypt.hash(password, 12) : existingRows[0].password_hash;

    await db.query(
      `UPDATE companies SET company_name=?, email=?, password_hash=?, phone=?, address=?, whatsapp=?,
              pricing_mode=?, scheduling_mode=?, currency=?
       WHERE id=?`,
      [companyName, email, passwordHash, phone, address, whatsapp, pricingMode, schedulingMode, currency, id]
    );

    // a password change here should sign that company out everywhere,
    // exactly like a company changing its own password does
    if (password) {
      await db.query('UPDATE companies SET token_version = token_version + 1 WHERE id = ?', [id]);
    }

    res.json({ message: 'Company updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/companies/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad company id' });

    // cascades to that company's products, images, bookings, sections —
    // same as deleting a row directly in company.sql
    const [result] = await db.query('DELETE FROM companies WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Company not found' });

    res.json({ message: 'Company deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ============================================================
// PUBLIC ROUTES  (called by the B2C sites — no login)
//
// Nothing here may return customer names, emails, phone numbers,
// booking amounts, or company login details.
// ============================================================

// only the fields a customer-facing page legitimately needs
app.get('/api/public/company/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad company id' });

    const [rows] = await db.query(
      `SELECT id, company_name, whatsapp, qr_code_url, pricing_mode, scheduling_mode, currency
       FROM companies WHERE id = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Company not found' });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/public/products', async (req, res) => {
  try {
    const companyId = parseId(req.query.company_id);
    if (!companyId) return res.status(400).json({ error: 'Bad company id' });

    const settings = await getCompanySettings(companyId);
    if (!settings) return res.status(404).json({ error: 'Company not found' });

    const { from, to } = req.query;

    const [products] = await db.query(
      `SELECT products.id, products.name, products.description, products.price, products.discount_price,
              products.start_time, products.end_time, products.section_id,
              product_sections.name AS section_name
       FROM products
       LEFT JOIN product_sections ON product_sections.id = products.section_id
       WHERE products.company_id = ? ORDER BY products.created_at DESC`,
      [companyId]
    );

    for (const product of products) {
      const [images] = await db.query(
        'SELECT image_url FROM product_images WHERE product_id = ?',
        [product.id]
      );
      product.images = images.map(i => i.image_url);
      product.available = true;
    }

    if (isValidDate(from) && isValidDate(to)) {
      if (settings.scheduling_mode === 'hour') {
        for (const p of products) {
          p.available = await hourSlotsAvailableOnDate(p.id, from);
        }
      } else {
        const [booked] = await db.query(
          `SELECT DISTINCT product_id FROM bookings
           WHERE company_id = ? AND status <> 'cancelled'
             AND ${overlapClause(settings.pricing_mode)}`,
          [companyId, to, from]
        );
        const takenIds = booked.map(b => b.product_id);
        for (const p of products) {
          if (takenIds.includes(p.id)) { p.available = false; continue; }
          if (await hasExcludedDateInRange(p.id, from, to)) p.available = false;
        }
      }
    }

    res.json({
      pricing_mode: settings.pricing_mode,
      scheduling_mode: settings.scheduling_mode,
      currency: settings.currency,
      products
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/public/products/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad product id' });

    const [products] = await db.query(
      `SELECT products.id, products.company_id, products.name, products.description, products.price,
              products.discount_price, products.start_time, products.end_time, products.section_id,
              product_sections.name AS section_name
       FROM products
       LEFT JOIN product_sections ON product_sections.id = products.section_id
       WHERE products.id = ?`,
      [id]
    );
    if (products.length === 0) return res.status(404).json({ error: 'Product not found' });

    const product = products[0];
    const settings = await getCompanySettings(product.company_id);

    const [images] = await db.query(
      'SELECT image_url FROM product_images WHERE product_id = ?',
      [product.id]
    );
    product.images = images.map(i => i.image_url);

    const { from, to } = req.query;
    product.available = true;

    if (isValidDate(from) && isValidDate(to)) {
      if (settings.scheduling_mode === 'hour') {
        product.available = await hourSlotsAvailableOnDate(product.id, from);
      } else {
        const [clash] = await db.query(
          `SELECT id FROM bookings
           WHERE product_id = ? AND status <> 'cancelled'
             AND ${overlapClause(settings.pricing_mode)} LIMIT 1`,
          [product.id, to, from]
        );
        product.available = clash.length === 0 && !(await hasExcludedDateInRange(product.id, from, to));
      }
    }

    product.pricing_mode = settings.pricing_mode;
    product.scheduling_mode = settings.scheduling_mode;
    product.currency = settings.currency;

    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// every slot a product offers, marked with whether it's still free on
// the requested date — this is what the B2C site's time picker uses
app.get('/api/public/products/:id/time-slots', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const date = req.query.date;
    if (!id) return res.status(400).json({ error: 'Bad product id' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'A valid date is required' });

    const [slots] = await db.query(
      'SELECT id, start_time, end_time FROM product_time_slots WHERE product_id = ? ORDER BY start_time ASC',
      [id]
    );

    const [bookedRows] = await db.query(
      `SELECT start_time FROM bookings
       WHERE product_id = ? AND status <> 'cancelled' AND start_date = ? AND start_time IS NOT NULL`,
      [id, date]
    );
    const bookedTimes = new Set(bookedRows.map(r => r.start_time));
    const dateExcluded = await hasExcludedDateInRange(id, date, date);

    const result = slots.map(s => ({
      id: s.id,
      start_time: s.start_time.slice(0, 5),
      end_time: s.end_time.slice(0, 5),
      available: !dateExcluded && !bookedTimes.has(s.start_time)
    }));

    res.json({ slots: result, date_excluded: dateExcluded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// booked date ranges only — deliberately no customer fields
app.get('/api/public/availability', async (req, res) => {
  try {
    const companyId = parseId(req.query.company_id);
    const from = req.query.from;
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 60);

    if (!companyId || !isValidDate(from)) {
      return res.status(400).json({ error: 'company_id and from are required' });
    }

    const settings = await getCompanySettings(companyId);
    if (!settings) return res.status(404).json({ error: 'Company not found' });

    const windowEnd = new Date(from + 'T00:00:00');
    windowEnd.setDate(windowEnd.getDate() + days);
    const to = windowEnd.toISOString().split('T')[0];

    const [ranges] = await db.query(
      `SELECT product_id, start_date, end_date FROM bookings
       WHERE company_id = ? AND status <> 'cancelled'
         AND start_date <= ? AND end_date >= ?`,
      [companyId, to, from]
    );

    const [exclusions] = await db.query(
      `SELECT product_date_exclusions.product_id, excluded_date
       FROM product_date_exclusions
       JOIN products ON products.id = product_date_exclusions.product_id
       WHERE products.company_id = ? AND excluded_date BETWEEN ? AND ?`,
      [companyId, from, to]
    );

    res.json({ pricing_mode: settings.pricing_mode, scheduling_mode: settings.scheduling_mode, ranges, exclusions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Creating a booking is public, but the company and the price are both
// derived server-side. A caller cannot choose who gets the booking, and
// cannot talk the system into a cheaper total.
app.post('/api/public/bookings', bookingLimiter, async (req, res) => {
  try {
    const productId = parseId(req.body.product_id);
    const customerName = cleanText(req.body.customer_name, 120);
    const customerEmail = cleanText(req.body.customer_email, 255);
    const customerPhone = cleanText(req.body.customer_phone, 40);
    const { start_date, end_date } = req.body;

    if (!productId) return res.status(400).json({ error: 'No product selected' });
    if (!customerName) return res.status(400).json({ error: 'Please enter your name' });
    if (!isValidEmail(customerEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    const [products] = await db.query(
      'SELECT id, company_id, price, discount_price FROM products WHERE id = ?',
      [productId]
    );
    if (products.length === 0) return res.status(404).json({ error: 'Product not found' });

    const product = products[0];
    const ownerId = product.company_id;                 // never from the request
    const settings = await getCompanySettings(ownerId);

    const rangeError = checkRange(start_date, end_date, settings.pricing_mode);
    if (rangeError) return res.status(400).json({ error: rangeError });

    let bookingStartTime = null;
    let bookingEndTime = null;

    if (settings.scheduling_mode === 'hour') {
      const requestedStart = parseTime(req.body.start_time, null);
      const requestedEnd = parseTime(req.body.end_time, null);
      if (!requestedStart || !requestedEnd) {
        return res.status(400).json({ error: 'Choose a time slot' });
      }

      // the chosen time must exactly match one of this product's real slots —
      // never trust a client-supplied time range on its own
      const [slotRows] = await db.query(
        'SELECT id FROM product_time_slots WHERE product_id = ? AND start_time = ? AND end_time = ?',
        [productId, requestedStart, requestedEnd]
      );
      if (slotRows.length === 0) {
        return res.status(400).json({ error: 'That time is not offered for this service' });
      }

      if (await hasExcludedDateInRange(productId, start_date, end_date)) {
        return res.status(409).json({ error: 'Not available during this date' });
      }

      // only THIS exact date+time needs to be free — other slots on the
      // same date, or the same time on a different date, are unaffected
      const [clash] = await db.query(
        `SELECT id FROM bookings
         WHERE product_id = ? AND status <> 'cancelled' AND start_date = ? AND start_time = ? LIMIT 1`,
        [productId, start_date, requestedStart]
      );
      if (clash.length > 0) {
        return res.status(409).json({ error: 'That time was just booked by someone else. Please choose another.' });
      }

      bookingStartTime = requestedStart;
      bookingEndTime = requestedEnd;
    } else {
      const [clash] = await db.query(
        `SELECT id FROM bookings
         WHERE product_id = ? AND status <> 'cancelled'
           AND ${overlapClause(settings.pricing_mode)} LIMIT 1`,
        [productId, end_date, start_date]
      );
      if (clash.length > 0) {
        return res.status(409).json({ error: 'Not available during this date' });
      }

      if (await hasExcludedDateInRange(productId, start_date, end_date)) {
        return res.status(409).json({ error: 'Not available during this date' });
      }
    }

    const unitPrice = product.discount_price ?? product.price;
    const amount = settings.scheduling_mode === 'hour'
      ? Number(unitPrice)
      : Number(unitPrice) * countUnits(start_date, end_date, settings.pricing_mode);

    const [result] = await db.query(
      `INSERT INTO bookings
         (product_id, company_id, customer_name, customer_email, customer_phone,
          start_date, end_date, start_time, end_time, amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [productId, ownerId, customerName, customerEmail, customerPhone,
       start_date, end_date, bookingStartTime, bookingEndTime, amount]
    );

    res.json({ message: 'Booking created', id: result.insertId, amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ============================================================
// PRIVATE ROUTES  (the dashboard — token required)
// Everything below uses req.company.id from the verified token.
// ============================================================

app.use('/api/me', requireAuth);

app.get('/api/me', (req, res) => {
  const { token_version, ...company } = req.company;
  res.json(company);
});

app.put('/api/me', async (req, res) => {
  try {
    const companyName = cleanText(req.body.company_name, 255);
    const email = cleanText(req.body.email, 255);
    const phone = cleanText(req.body.phone, 50);
    const address = cleanText(req.body.address, 255);
    const whatsapp = cleanText(req.body.whatsapp, 50);

    if (!companyName) return res.status(400).json({ error: 'Company name is required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (whatsapp && !/^\d{6,20}$/.test(whatsapp)) {
      return res.status(400).json({ error: 'WhatsApp number should be digits only' });
    }

    // email is unique — check before writing so we can explain the failure
    const [taken] = await db.query(
      'SELECT id FROM companies WHERE email = ? AND id <> ?',
      [email, req.company.id]
    );
    if (taken.length > 0) {
      return res.status(409).json({ error: 'That email is already in use' });
    }

    await db.query(
      `UPDATE companies SET company_name=?, email=?, phone=?, address=?, whatsapp=?
       WHERE id=?`,
      [companyName, email, phone, address, whatsapp, req.company.id]
    );

    res.json({ message: 'Company details updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Changing a password requires proving you know the current one, so a
// hijacked open tab can't be used to lock the real owner out.
app.put('/api/me/password', async (req, res) => {
  try {
    const currentPassword = typeof req.body.current_password === 'string' ? req.body.current_password : '';
    const newPassword = typeof req.body.new_password === 'string' ? req.body.new_password : '';

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    if (newPassword.length > 200) {
      return res.status(400).json({ error: 'New password is too long' });
    }

    const [rows] = await db.query(
      'SELECT password_hash FROM companies WHERE id = ?',
      [req.company.id]
    );

    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is not correct' });

    const hash = await bcrypt.hash(newPassword, 12);

    // bumping token_version signs every existing session out
    await db.query(
      'UPDATE companies SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
      [hash, req.company.id]
    );

    res.json({ message: 'Password changed. Please log in again.', reauth: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// day = whole-day bookings (resorts, tours) — hours aren't used at all.
// hour = time-slot bookings (barbershop). Switching modes never validates
// existing product hours here: in day mode those hours are unused
// placeholders (often identical across products by default), so checking
// them at switch time would block every company with 2+ products from
// ever turning Hours setting on. The real collision check already runs
// whenever a product's hours are actually saved (see /api/me/products).
app.put('/api/me/scheduling-mode', async (req, res) => {
  try {
    const mode = req.body.scheduling_mode;
    if (!['day', 'hour'].includes(mode)) {
      return res.status(400).json({ error: 'Scheduling mode must be "day" or "hour"' });
    }

    await db.query('UPDATE companies SET scheduling_mode = ? WHERE id = ?', [mode, req.company.id]);
    res.json({ message: 'Scheduling mode updated', scheduling_mode: mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me/sections', async (req, res) => {
  try {
    let [sections] = await db.query(
      'SELECT id, name, sort_order FROM product_sections WHERE company_id = ? ORDER BY sort_order ASC, id ASC',
      [req.company.id]
    );

    // every company always has at least one real section — if none exist
    // yet (brand new company, or the last one was just deleted), create
    // "General" here
    if (sections.length === 0) {
      const [result] = await db.query(
        'INSERT INTO product_sections (company_id, name, sort_order) VALUES (?, ?, 0)',
        [req.company.id, 'General']
      );
      sections = [{ id: result.insertId, name: 'General', sort_order: 0 }];
    }

    // sweep any product left without a section — whether from before
    // sections existed at all, or from any other edge case — into the
    // first section, so nothing ever becomes invisible. Cheap no-op
    // when there's nothing to sweep.
    await db.query(
      'UPDATE products SET section_id = ? WHERE company_id = ? AND section_id IS NULL',
      [sections[0].id, req.company.id]
    );

    res.json({ sections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/me/sections', async (req, res) => {
  try {
    const name = cleanText(req.body.name, 255);
    if (!name) return res.status(400).json({ error: 'Section name is required' });

    const [countRows] = await db.query(
      'SELECT COUNT(*) AS count FROM product_sections WHERE company_id = ?',
      [req.company.id]
    );

    const [result] = await db.query(
      'INSERT INTO product_sections (company_id, name, sort_order) VALUES (?, ?, ?)',
      [req.company.id, name, countRows[0].count]
    );

    res.json({ message: 'Section created', id: result.insertId, name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/me/sections/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const name = cleanText(req.body.name, 255);
    if (!id) return res.status(400).json({ error: 'Bad section id' });
    if (!name) return res.status(400).json({ error: 'Section name is required' });

    const [result] = await db.query(
      'UPDATE product_sections SET name = ? WHERE id = ? AND company_id = ?',
      [name, id, req.company.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Section not found' });

    res.json({ message: 'Section renamed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// deleting a section never deletes or orphans its products — they're
// unassigned back to "no section" first
app.delete('/api/me/sections/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad section id' });

    const [others] = await db.query(
      'SELECT id FROM product_sections WHERE company_id = ? AND id <> ? ORDER BY sort_order ASC, id ASC LIMIT 1',
      [req.company.id, id]
    );
    if (others.length === 0) {
      return res.status(400).json({
        error: 'You need at least one section — rename this one instead of deleting it, or add another section first.'
      });
    }

    // move this section's products into another real section rather than
    // leaving them with no section at all
    await db.query(
      'UPDATE products SET section_id = ? WHERE section_id = ? AND company_id = ?',
      [others[0].id, id, req.company.id]
    );

    const [result] = await db.query(
      'DELETE FROM product_sections WHERE id = ? AND company_id = ?',
      [id, req.company.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Section not found' });

    res.json({ message: 'Section deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------
// DATE EXCLUSIONS — manually blocking a product off on specific
// dates, regardless of whether anything is actually booked on them
// ------------------------------------------------------------

app.get('/api/me/products/:id/exclusions', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id || !(await ownsProduct(req.company.id, id))) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const [rows] = await db.query(
      'SELECT excluded_date, excluded_start_time, excluded_end_time FROM product_date_exclusions WHERE product_id = ? ORDER BY excluded_date ASC',
      [id]
    );
    // mysql2 returns DATE columns as JS Date objects in local time —
    // format explicitly so the date the company picked is what comes back
    const exclusions = rows.map(r => {
      const d = r.excluded_date;
      const date = d instanceof Date
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        : d;
      return {
        date,
        start_time: r.excluded_start_time ? r.excluded_start_time.slice(0, 5) : null,
        end_time: r.excluded_end_time ? r.excluded_end_time.slice(0, 5) : null
      };
    });

    res.json({ exclusions, dates: exclusions.map(e => e.date) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/me/products/:id/exclusions', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id || !(await ownsProduct(req.company.id, id))) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const date = req.body.date;
    if (!isValidDate(date)) return res.status(400).json({ error: 'Enter a valid date' });

    // optional — only meaningful in Hours mode. Both or neither: a
    // half-specified range is treated as "whole day" instead of guessing
    const hasTimeRange = isValidTime(req.body.start_time) && isValidTime(req.body.end_time);
    const startTime = hasTimeRange ? parseTime(req.body.start_time, null) : null;
    const endTime = hasTimeRange ? parseTime(req.body.end_time, null) : null;
    if (hasTimeRange && startTime === endTime) {
      return res.status(400).json({ error: 'Start time and end time cannot be the same' });
    }

    await db.query(
      `INSERT INTO product_date_exclusions (product_id, excluded_date, excluded_start_time, excluded_end_time)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE excluded_start_time = VALUES(excluded_start_time), excluded_end_time = VALUES(excluded_end_time)`,
      [id, date, startTime, endTime]
    );

    res.json({ message: 'Date blocked', date, start_time: startTime, end_time: endTime });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/me/products/:id/exclusions/:date', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id || !(await ownsProduct(req.company.id, id))) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const date = req.params.date;
    if (!isValidDate(date)) return res.status(400).json({ error: 'Bad date' });

    await db.query(
      'DELETE FROM product_date_exclusions WHERE product_id = ? AND excluded_date = ?',
      [id, date]
    );

    res.json({ message: 'Date unblocked', date });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------
// TIME SLOTS — Hours-mode products offer several bookable times per
// day instead of one fixed window. Each slot must not overlap any
// other slot across the whole company (same shared-schedule rule the
// old per-product check used, just enforced per-slot now).
// ------------------------------------------------------------

app.get('/api/me/products/:id/time-slots', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id || !(await ownsProduct(req.company.id, id))) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const [rows] = await db.query(
      'SELECT id, start_time, end_time FROM product_time_slots WHERE product_id = ? ORDER BY start_time ASC',
      [id]
    );
    const slots = rows.map(r => ({
      id: r.id,
      start_time: r.start_time.slice(0, 5),
      end_time: r.end_time.slice(0, 5)
    }));

    res.json({ slots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/me/products/:id/time-slots', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id || !(await ownsProduct(req.company.id, id))) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const startTime = parseTime(req.body.start_time, null);
    const endTime = parseTime(req.body.end_time, null);
    if (!startTime || !endTime) return res.status(400).json({ error: 'Enter a valid start and end time' });
    if (startTime === endTime) return res.status(400).json({ error: 'Start time and end time cannot be the same' });

    const collision = await findSlotCollision(req.company.id, startTime, endTime, null);
    if (collision) {
      return res.status(409).json({
        error: `That time overlaps with "${collision.product_name}"'s slot (${collision.start_time.slice(0,5)}\u2013${collision.end_time.slice(0,5)}). Choose a different time.`
      });
    }

    const [result] = await db.query(
      'INSERT INTO product_time_slots (product_id, start_time, end_time) VALUES (?, ?, ?)',
      [id, startTime, endTime]
    );

    res.json({ message: 'Slot added', slot: { id: result.insertId, start_time: startTime.slice(0,5), end_time: endTime.slice(0,5) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/me/products/:id/time-slots/:slotId', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const slotId = parseId(req.params.slotId);
    if (!id || !slotId || !(await ownsProduct(req.company.id, id))) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const [result] = await db.query(
      'DELETE FROM product_time_slots WHERE id = ? AND product_id = ?',
      [slotId, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Slot not found' });

    res.json({ message: 'Slot removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/me/qr', upload.single('qr'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No QR image received' });

    const qrUrl = '/uploads/' + req.file.filename;
    await db.query('UPDATE companies SET qr_code_url = ? WHERE id = ?', [qrUrl, req.company.id]);

    res.json({ message: 'QR uploaded', qr_code_url: qrUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me/products', async (req, res) => {
  try {
    const [products] = await db.query(
      'SELECT * FROM products WHERE company_id = ? ORDER BY created_at DESC',
      [req.company.id]
    );

    for (const product of products) {
      const [images] = await db.query(
        'SELECT id, image_url FROM product_images WHERE product_id = ? ORDER BY id ASC',
        [product.id]
      );
      product.images = images.map(i => ({ id: i.id, url: i.image_url }));

      const [slots] = await db.query(
        'SELECT id, start_time, end_time FROM product_time_slots WHERE product_id = ? ORDER BY start_time ASC',
        [product.id]
      );
      product.time_slots = slots.map(s => ({ id: s.id, start_time: s.start_time.slice(0,5), end_time: s.end_time.slice(0,5) }));
    }

    res.json({
      pricing_mode: req.company.pricing_mode,
      scheduling_mode: req.company.scheduling_mode,
      currency: req.company.currency,
      products
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/me/products', upload.array('images', 5), async (req, res) => {
  try {
    const name = cleanText(req.body.name, 255);
    const description = cleanText(req.body.description, 2000);
    const price = parseMoney(req.body.price);
    const discount = parseMoney(req.body.discount_price);
    const startTime = parseTime(req.body.start_time, '09:00:00');
    const endTime = parseTime(req.body.end_time, '18:00:00');
    const colorIndex = parseColorIndex(req.body.color_index);

    let sectionId = null;
    if (req.body.section_id) {
      sectionId = parseId(req.body.section_id);
      if (!sectionId) return res.status(400).json({ error: 'Bad section id' });
      const [secRows] = await db.query(
        'SELECT id FROM product_sections WHERE id = ? AND company_id = ?',
        [sectionId, req.company.id]
      );
      if (secRows.length === 0) return res.status(400).json({ error: 'Section not found' });
    }

    if (!name) return res.status(400).json({ error: 'Product name is required' });
    if (price === null) return res.status(400).json({ error: 'Enter a valid price' });
    if (discount !== null && discount > price) {
      return res.status(400).json({ error: 'Discount price cannot be higher than the price' });
    }
    // an overnight window (e.g. check-in 3pm, check-out 11am next day) is
    // allowed — only reject when both times land on the exact same minute
    if (startTime === endTime) {
      return res.status(400).json({ error: 'Start time and end time cannot be the same' });
    }

    const [result] = await db.query(
      `INSERT INTO products (company_id, name, description, price, discount_price, start_time, end_time, color_index, section_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.company.id, name, description, price, discount, startTime, endTime, colorIndex, sectionId]
    );

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        await db.query(
          'INSERT INTO product_images (product_id, image_url) VALUES (?, ?)',
          [result.insertId, '/uploads/' + file.filename]
        );
      }
    }

    res.json({ message: 'Product created', id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/me/products/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad product id' });

    // fetch the existing row (also proves ownership) so unsent time
    // fields fall back to what's already saved instead of a default
    const [existingRows] = await db.query(
      'SELECT start_time, end_time, color_index, section_id FROM products WHERE id = ? AND company_id = ?',
      [id, req.company.id]
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Product not found' });

    const name = cleanText(req.body.name, 255);
    const description = cleanText(req.body.description, 2000);
    const price = parseMoney(req.body.price);
    const discount = parseMoney(req.body.discount_price);
    const startTime = parseTime(req.body.start_time, existingRows[0].start_time);
    const endTime = parseTime(req.body.end_time, existingRows[0].end_time);
    const colorIndex = req.body.color_index === undefined
      ? existingRows[0].color_index
      : parseColorIndex(req.body.color_index);

    let sectionId = existingRows[0].section_id;
    if (req.body.section_id !== undefined) {
      if (req.body.section_id === null || req.body.section_id === '') {
        sectionId = null;
      } else {
        sectionId = parseId(req.body.section_id);
        if (!sectionId) return res.status(400).json({ error: 'Bad section id' });
        const [secRows] = await db.query(
          'SELECT id FROM product_sections WHERE id = ? AND company_id = ?',
          [sectionId, req.company.id]
        );
        if (secRows.length === 0) return res.status(400).json({ error: 'Section not found' });
      }
    }

    if (!name) return res.status(400).json({ error: 'Product name is required' });
    if (price === null) return res.status(400).json({ error: 'Enter a valid price' });
    if (discount !== null && discount > price) {
      return res.status(400).json({ error: 'Discount price cannot be higher than the price' });
    }
    if (startTime === endTime) {
      return res.status(400).json({ error: 'Start time and end time cannot be the same' });
    }

    await db.query(
      `UPDATE products SET name=?, description=?, price=?, discount_price=?, start_time=?, end_time=?, color_index=?, section_id=?
       WHERE id=? AND company_id=?`,
      [name, description, price, discount, startTime, endTime, colorIndex, sectionId, id, req.company.id]
    );

    res.json({ message: 'Product updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/me/products/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad product id' });

    // company_id in the WHERE is what stops one client deleting another's row
    const [result] = await db.query(
      'DELETE FROM products WHERE id = ? AND company_id = ?',
      [id, req.company.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// add more images to a product that's already saved (up to 5 in total)
app.post('/api/me/products/:id/images', upload.array('images', 5), async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad product id' });
    if (!(await ownsProduct(req.company.id, id))) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const [countRows] = await db.query(
      'SELECT COUNT(*) AS count FROM product_images WHERE product_id = ?',
      [id]
    );
    const existingCount = countRows[0].count;
    const incoming = req.files ? req.files.length : 0;

    if (incoming === 0) return res.status(400).json({ error: 'No images received' });
    if (existingCount + incoming > 5) {
      return res.status(400).json({
        error: `A product can have at most 5 images (it already has ${existingCount})`
      });
    }

    const inserted = [];
    for (const file of req.files) {
      const url = '/uploads/' + file.filename;
      const [result] = await db.query(
        'INSERT INTO product_images (product_id, image_url) VALUES (?, ?)',
        [id, url]
      );
      inserted.push({ id: result.insertId, url });
    }

    res.json({ message: 'Images added', images: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// remove a single image from a product
app.delete('/api/me/products/:id/images/:imageId', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const imageId = parseId(req.params.imageId);
    if (!id || !imageId) return res.status(400).json({ error: 'Bad id' });
    if (!(await ownsProduct(req.company.id, id))) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const [rows] = await db.query(
      'SELECT image_url FROM product_images WHERE id = ? AND product_id = ?',
      [imageId, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Image not found' });

    await db.query('DELETE FROM product_images WHERE id = ? AND product_id = ?', [imageId, id]);

    // best-effort cleanup on disk — a failed unlink shouldn't fail the request,
    // the DB row (the source of truth for what the site displays) is already gone
    const filePath = path.join(uploadDir, path.basename(rows[0].image_url));
    fs.unlink(filePath, () => {});

    res.json({ message: 'Image removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me/bookings', async (req, res) => {
  try {
    const [bookings] = await db.query(
      `SELECT bookings.*, products.name AS product_name,
              products.start_time AS product_start_time,
              products.end_time AS product_end_time,
              products.color_index AS product_color_index
       FROM bookings
       JOIN products ON bookings.product_id = products.id
       WHERE bookings.company_id = ?
       ORDER BY bookings.start_date DESC`,
      [req.company.id]
    );

    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/me/bookings/:id/status', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const { status } = req.body;
    const cancelReason = cleanText(req.body.cancel_reason, 255);

    if (!id) return res.status(400).json({ error: 'Bad booking id' });
    if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Unknown booking status' });
    }

    const finalCancelReason = status === 'cancelled' ? (cancelReason || 'Cancelled by company') : null;

    const [result] = await db.query(
      'UPDATE bookings SET status = ?, cancel_reason = ? WHERE id = ? AND company_id = ?',
      [status, finalCancelReason, id, req.company.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // fetched fresh (rather than trusting anything from the request body)
    // so every email reflects what's actually in the database
    if (status === 'confirmed') {
      const [rows] = await db.query(
        `SELECT bookings.*, products.name AS product_name,
                companies.company_name, companies.pricing_mode, companies.scheduling_mode, companies.currency
         FROM bookings
         JOIN products ON bookings.product_id = products.id
         JOIN companies ON bookings.company_id = companies.id
         WHERE bookings.id = ? AND bookings.company_id = ?`,
        [id, req.company.id]
      );
      if (rows.length > 0) await sendReceiptEmail(rows[0]);
    }

    if (status === 'cancelled') {
      const [rows] = await db.query(
        `SELECT bookings.*, products.name AS product_name,
                companies.company_name, companies.pricing_mode, companies.scheduling_mode, companies.currency
         FROM bookings
         JOIN products ON bookings.product_id = products.id
         JOIN companies ON bookings.company_id = companies.id
         WHERE bookings.id = ? AND bookings.company_id = ?`,
        [id, req.company.id]
      );
      if (rows.length > 0) {
        if (finalCancelReason === PAYMENT_ERROR_REASON) {
          await sendPaymentErrorEmail(rows[0], req.company.phone);
        } else {
          await sendCancellationEmail(rows[0]);
        }
      }
    }

    res.json({ message: 'Booking updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ------------------------------------------------------------
// ERROR HANDLER
// Returns a short message. Stack traces stay in the server log,
// because they tell an attacker how the system is built.
// ------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Images must be under 5MB'
      : 'Could not accept that upload';
    return res.status(400).json({ error: message });
  }
  if (err && err.message === 'Only JPG, PNG, WEBP or GIF images are allowed') {
    return res.status(400).json({ error: err.message });
  }
  if (err && err.message === 'Origin not allowed') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ') || '(none set — browsers will be blocked)'}`);
});