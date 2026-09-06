// config.js (Barber Retreat and Resort Co. — B2C site)
// The one place this site's identity is declared. Every other script
// on this site reads COMPANY_ID from here instead of hardcoding it.

window.SITE = {
  API_URL: 'http://booking-system-production-fa13.up.railway.app',
  // Update this once "Barber Retreat and Resort Co." has been added via
  // company.sql — this is a placeholder until then. Check the real id with:
  //   SELECT id, company_name FROM companies WHERE company_name = 'Barber Retreat and Resort Co.';
  COMPANY_ID: 4,
  FALLBACK_WHATSAPP: '60123456789'   // used only if the company record has none set
};
