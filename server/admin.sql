-- ============================================
-- PLATFORM ADMIN LOGIN
--   mysql -u root -p booking_system < admin.sql
--
-- This creates YOUR login for the admin portal (admin-portal/) — the
-- internal tool that manages the company list. It's completely separate
-- from any company's own login.
--
-- You only need to run this once. After that, the portal itself handles
-- everything else (adding, editing, deleting companies) — you won't
-- need hash-password.js or company.sql for new companies anymore.
--
-- ------------------------------------------------------------
-- STEP 1 — hash your chosen password (MySQL has no built-in bcrypt,
-- so this has to happen in Node first, same tool as before):
--
--   node hash-password.js "YourChosenPassword"
--
-- Paste the printed $2b$12$... hash below.
-- ------------------------------------------------------------

USE booking_system;

INSERT INTO platform_admins (email, password_hash)
VALUES (
  'admin@ssz.com',
  '$2b$12$kRED5mwEGC9SaR1jlFEA7uKPC6OQyNAYvAKAVrKcn9OfMeZBmkU7u
'
)
ON DUPLICATE KEY UPDATE
  password_hash = VALUES(password_hash);