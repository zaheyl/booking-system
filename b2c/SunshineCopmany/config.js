// config.js (Sunshine Travel Co. — B2C site)
// The one place this site's identity is declared. Every other script
// on this site reads COMPANY_ID from here instead of hardcoding it,
// so it's impossible for this site to accidentally show another
// company's products or bookings.

window.SITE = {
  API_URL: 'https://booking-system-production-fa13.up.railway.app',
  COMPANY_ID: 1,                     // Sunshine Travel Co.'s row in `companies`
  FALLBACK_WHATSAPP: '60123456789'   // used only if the company record has none set
};
