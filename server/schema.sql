-- ============================================
-- BOOKING SYSTEM DATABASE
--   mysql -u root -p < schema.sql
--
-- This file is safe to run at ANY time, on a brand-new database
-- or one you've already been using:
--   - Tables are only created if they don't already exist
--   - Missing columns (like products.start_time, companies.scheduling_mode)
--     are added automatically, without touching any existing rows
--   - Demo data is only inserted once — the very first time,
--     when the companies table is still empty. If you already
--     have real companies/products/bookings, this file will not
--     touch them.
--
-- Every "add this column if missing" and "add this index if missing"
-- step below uses an INFORMATION_SCHEMA check + PREPARE/EXECUTE rather
-- than "ADD COLUMN IF NOT EXISTS" — that syntax needs MySQL 8.0.29+
-- and isn't supported everywhere, so this version works on any MySQL
-- or MariaDB release without needing to check your version first.
--
-- Passwords are bcrypt hashes, never plain text.
-- Both demo accounts use the password: 123456
-- Change them in the dashboard after first login.
-- ============================================

CREATE DATABASE IF NOT EXISTS booking_system;
USE booking_system;

-- ------------------------------------------------------------
-- TABLES
-- ------------------------------------------------------------

-- platform-level login, separate from every company's own login. Used
-- only by the internal admin portal (admin-portal/) that manages which
-- companies exist at all — never exposed to companies themselves.
CREATE TABLE IF NOT EXISTS platform_admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,        -- bcrypt, cost 12
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,        -- bcrypt, cost 12
  phone VARCHAR(50),
  address VARCHAR(255),
  whatsapp VARCHAR(50),
  qr_code_url VARCHAR(500),
  pricing_mode ENUM('per_day','per_night') NOT NULL DEFAULT 'per_day',
  -- 'day' = book a date range (resorts, tours); 'hour' = book a time
  -- slot (barbershops). See product_sections and product_date_exclusions
  -- below, which support both modes.
  scheduling_mode ENUM('day','hour') NOT NULL DEFAULT 'day',
  currency VARCHAR(5) NOT NULL DEFAULT '$',
  token_version INT NOT NULL DEFAULT 0,       -- bumped on password change to kill old tokens
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- groups products together (e.g. by barber, by building, by room type).
-- Every company always has an implicit "General" group for products
-- with no section_id — that's rendered by the dashboard, not stored here.
CREATE TABLE IF NOT EXISTS product_sections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  discount_price DECIMAL(10,2) NULL,
  start_time TIME NOT NULL DEFAULT '09:00:00',
  end_time TIME NOT NULL DEFAULT '18:00:00',
  color_index TINYINT NULL,
  section_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_products_section FOREIGN KEY (section_id) REFERENCES product_sections(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_images (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  image_url VARCHAR(500) NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- a date manually blocked off for one product — the booking system will
-- treat it as unavailable regardless of whether anything's booked on it
CREATE TABLE IF NOT EXISTS product_date_exclusions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  excluded_date DATE NOT NULL,
  -- optional — records which hours were blocked (Hours mode); NULL means
  -- the whole day is blocked (the normal case in Day mode). A product only
  -- has one bookable window per day either way, so this is informational
  -- for the company's own reference rather than something finer-grained
  -- availability math depends on.
  excluded_start_time TIME NULL,
  excluded_end_time TIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_product_date (product_id, excluded_date)
);

-- Hours-mode products can offer several bookable times per day (e.g. a
-- barber offering 9:00, 9:30, 2:00) instead of one fixed window. A slot
-- can't overlap any other slot belonging to ANY product in the company —
-- same "one shared schedule" rule as before, just enforced per-slot now
-- instead of per-product.
CREATE TABLE IF NOT EXISTS product_time_slots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bookings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  company_id INT NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(50),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  -- only set for Hours-mode bookings — which specific slot was chosen.
  -- NULL for Day-mode bookings, which don't have a time component.
  start_time TIME NULL,
  end_time TIME NULL,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  status ENUM('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending',
  cancel_reason VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- Records failed and successful logins so brute force attempts are visible.
CREATE TABLE IF NOT EXISTS login_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255),
  ip VARCHAR(64),
  successful TINYINT(1) NOT NULL DEFAULT 0,
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- COLUMN REPAIR
-- For a database that already had these tables before a column was
-- introduced — checks INFORMATION_SCHEMA first and only adds what's
-- actually missing. A brand-new database already has every column
-- from the CREATE TABLE statements above, so these are all no-ops here.
-- ------------------------------------------------------------

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'companies' AND column_name = 'scheduling_mode');
SET @col_sql := IF(@col_exists = 0,
  "ALTER TABLE companies ADD COLUMN scheduling_mode ENUM('day','hour') NOT NULL DEFAULT 'day'",
  'SELECT 1');
PREPARE colstmt FROM @col_sql;
EXECUTE colstmt;
DEALLOCATE PREPARE colstmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'start_time');
SET @col_sql := IF(@col_exists = 0,
  "ALTER TABLE products ADD COLUMN start_time TIME NOT NULL DEFAULT '09:00:00'",
  'SELECT 1');
PREPARE colstmt FROM @col_sql;
EXECUTE colstmt;
DEALLOCATE PREPARE colstmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'end_time');
SET @col_sql := IF(@col_exists = 0,
  "ALTER TABLE products ADD COLUMN end_time TIME NOT NULL DEFAULT '18:00:00'",
  'SELECT 1');
PREPARE colstmt FROM @col_sql;
EXECUTE colstmt;
DEALLOCATE PREPARE colstmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'color_index');
SET @col_sql := IF(@col_exists = 0,
  'ALTER TABLE products ADD COLUMN color_index TINYINT NULL',
  'SELECT 1');
PREPARE colstmt FROM @col_sql;
EXECUTE colstmt;
DEALLOCATE PREPARE colstmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'section_id');
SET @col_sql := IF(@col_exists = 0,
  'ALTER TABLE products ADD COLUMN section_id INT NULL',
  'SELECT 1');
PREPARE colstmt FROM @col_sql;
EXECUTE colstmt;
DEALLOCATE PREPARE colstmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'product_date_exclusions' AND column_name = 'excluded_start_time');
SET @col_sql := IF(@col_exists = 0,
  'ALTER TABLE product_date_exclusions ADD COLUMN excluded_start_time TIME NULL',
  'SELECT 1');
PREPARE colstmt FROM @col_sql;
EXECUTE colstmt;
DEALLOCATE PREPARE colstmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'product_date_exclusions' AND column_name = 'excluded_end_time');
SET @col_sql := IF(@col_exists = 0,
  'ALTER TABLE product_date_exclusions ADD COLUMN excluded_end_time TIME NULL',
  'SELECT 1');
PREPARE colstmt FROM @col_sql;
EXECUTE colstmt;
DEALLOCATE PREPARE colstmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'bookings' AND column_name = 'start_time');
SET @col_sql := IF(@col_exists = 0,
  'ALTER TABLE bookings ADD COLUMN start_time TIME NULL',
  'SELECT 1');
PREPARE colstmt FROM @col_sql;
EXECUTE colstmt;
DEALLOCATE PREPARE colstmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'bookings' AND column_name = 'end_time');
SET @col_sql := IF(@col_exists = 0,
  'ALTER TABLE bookings ADD COLUMN end_time TIME NULL',
  'SELECT 1');
PREPARE colstmt FROM @col_sql;
EXECUTE colstmt;
DEALLOCATE PREPARE colstmt;

-- foreign key for section_id — only relevant if products existed
-- without it before; a brand-new table already has this from its
-- CREATE TABLE statement above
SET @fk_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE table_schema = DATABASE() AND table_name = 'products' AND constraint_name = 'fk_products_section');
SET @fk_sql := IF(@fk_exists = 0,
  'ALTER TABLE products ADD CONSTRAINT fk_products_section FOREIGN KEY (section_id) REFERENCES product_sections(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE fkstmt FROM @fk_sql;
EXECUTE fkstmt;
DEALLOCATE PREPARE fkstmt;

-- ------------------------------------------------------------
-- INDEXES
-- Same reasoning as above — MySQL has no "CREATE INDEX IF NOT EXISTS"
-- on most versions, so each one is checked first and only created
-- if it's actually missing.
-- ------------------------------------------------------------

SET @idx1 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'bookings' AND index_name = 'idx_bookings_range');
SET @sql1 := IF(@idx1 = 0,
  'CREATE INDEX idx_bookings_range ON bookings (product_id, start_date, end_date)',
  'SELECT 1');
PREPARE stmt1 FROM @sql1;
EXECUTE stmt1;
DEALLOCATE PREPARE stmt1;

SET @idx2 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'login_attempts' AND index_name = 'idx_login_attempts');
SET @sql2 := IF(@idx2 = 0,
  'CREATE INDEX idx_login_attempts ON login_attempts (email, attempted_at)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ------------------------------------------------------------
-- DEMO DATA
-- Only runs the very first time — skipped automatically once
-- the companies table has any rows in it, so re-running this
-- file later never duplicates or overwrites real data.
-- ------------------------------------------------------------

DELIMITER $$

CREATE PROCEDURE seed_demo_data()
BEGIN
  IF (SELECT COUNT(*) FROM companies) = 0 THEN

    -- COMPANY 1 - Sunshine Travel Co.  (per day, $)
    -- Login: admin@sunshine.com / 123456
    INSERT INTO companies (company_name, email, password_hash, phone, address, whatsapp, pricing_mode, scheduling_mode, currency) VALUES
    ('Sunshine Travel Co.', 'admin@sunshine.com',
     '$2b$12$1o8Mb1/5/Lvg21/NQu0JXucIJbMk4RqE84lAAsxJ0fpq7T.pfVoM.',
     '012-345 6789', '123 Beach Road, Port Dickson', '60123456789', 'per_night', 'day', '$');

    INSERT INTO products (company_id, name, description, price, discount_price, start_time, end_time) VALUES
    (1, 'Island Hopping Tour', 'A full day tour hopping between 3 beautiful islands. Includes lunch and snorkeling gear.', 250.00, 199.00, '08:00:00', '17:00:00'),
    (1, 'Sunset Cruise', 'Relax on a 2-hour sunset cruise with drinks included.', 150.00, NULL, '17:30:00', '19:30:00'),
    (1, 'Mangrove Kayaking', 'Guided kayaking tour through the mangrove forest, great for beginners.', 90.00, 75.00, '07:30:00', '11:00:00');

    INSERT INTO product_images (product_id, image_url) VALUES
    (1, 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800'),
    (1, 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=800'),
    (2, 'https://images.unsplash.com/photo-1500375592092-40eb2168fd21?w=800'),
    (3, 'https://images.unsplash.com/photo-1526401485004-46910ecc8e51?w=800');

    INSERT INTO bookings (product_id, company_id, customer_name, customer_email, customer_phone, start_date, end_date, amount, status) VALUES
    (1, 1, 'Jane Cooper', 'jane.cooper@example.com', '012-200 7783', '2026-08-01', '2026-08-01', 199.00, 'pending'),
    (2, 1, 'Marcus Lee', 'marcus.lee@example.com', '012-990 1122', '2026-08-14', '2026-08-16', 450.00, 'confirmed'),
    (3, 1, 'Priya Raman', 'priya.raman@example.com', '012-340 7765', '2026-07-10', '2026-07-11', 150.00, 'confirmed'),
    (2, 1, 'Tom Becker', 'tom.becker@example.com', '012-762 4498', '2026-07-02', '2026-07-03', 300.00, 'cancelled'),
    (1, 1, 'Alicia Wan', 'alicia.wan@example.com', '012-880 2211', '2026-08-16', '2026-08-16', 199.00, 'confirmed'),
    (3, 1, 'Reza Farid', 'reza.farid@example.com', '012-660 9911', '2026-08-16', '2026-08-17', 165.00, 'confirmed');

    -- COMPANY 2 - Homestay Pahang  (per night, RM)
    -- Login: admin@homestaypahang.com / 123456
    INSERT INTO companies (company_name, email, password_hash, phone, address, whatsapp, pricing_mode, scheduling_mode, currency) VALUES
    ('Homestay Pahang', 'admin@homestaypahang.com',
     '$2b$12$XL6/TQYJd/./LtAFgThkD.aos6amDaB9Ix.V8an1r6JRm/JOqNNRG',
     '019-778 2210', 'Kampung Sungai Lembing, 26200 Kuantan, Pahang', '60197782210', 'per_night', 'day', 'RM');

    INSERT INTO products (company_id, name, description, price, discount_price, start_time, end_time) VALUES
    (2, 'Riverside Chalet', 'Timber chalet on stilts above the river. Sleeps 2, with a private verandah and morning mist over the water.', 180.00, 150.00, '14:00:00', '12:00:00'),
    (2, 'Kampung Family House', 'A whole three-bedroom kampung house with a full kitchen and a shaded courtyard. Sleeps 8.', 320.00, NULL, '15:00:00', '11:00:00'),
    (2, 'Bamboo Loft', 'Open-sided bamboo loft tucked into the orchard. Fan-cooled, best in the cooler months. Sleeps 2.', 120.00, 99.00, '13:00:00', '11:00:00'),
    (2, 'Orchard Tent Deck', 'Raised canvas tent on a hardwood deck among the durian trees. Shared bathroom. Sleeps 3.', 85.00, NULL, '12:00:00', '10:00:00');

    INSERT INTO product_images (product_id, image_url) VALUES
    (4, 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800'),
    (4, 'https://images.unsplash.com/photo-1499696010180-025ef8c1d76a?w=800'),
    (5, 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=800'),
    (5, 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=800'),
    (6, 'https://images.unsplash.com/photo-1510798831971-661eb04b3739?w=800'),
    (7, 'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=800');

    INSERT INTO bookings (product_id, company_id, customer_name, customer_email, customer_phone, start_date, end_date, amount, status) VALUES
    (4, 2, 'Nurul Aina', 'nurul.aina@example.com', '013-455 2201', '2026-08-07', '2026-08-09', 300.00, 'pending'),
    (5, 2, 'Daniel Wong', 'daniel.wong@example.com', '017-221 9080', '2026-08-14', '2026-08-17', 960.00, 'confirmed'),
    (6, 2, 'Farah Idris', 'farah.idris@example.com', '011-3300 4412', '2026-07-04', '2026-07-06', 198.00, 'confirmed'),
    (7, 2, 'Kamal Hassan', 'kamal.hassan@example.com', '012-887 6543', '2026-07-18', '2026-07-19', 85.00, 'cancelled'),
    (6, 2, 'Siti Zubaidah', 'siti.zubaidah@example.com', '019-221 4477', '2026-08-17', '2026-08-19', 198.00, 'confirmed');

    UPDATE bookings SET cancel_reason = 'Change of plans' WHERE status = 'cancelled';

  END IF;
END$$

DELIMITER ;

CALL seed_demo_data();
DROP PROCEDURE seed_demo_data;