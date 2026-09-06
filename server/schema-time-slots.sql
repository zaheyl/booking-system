-- ============================================
-- TIME SLOTS MIGRATION
--   mysql -u root -p booking_system < schema-time-slots.sql
--
-- Replaces the old "one fixed time window per product" model in Hours
-- mode with multiple selectable time slots per product, and lets a
-- booking record which specific slot was chosen.
--
-- This is already folded into the main schema.sql — only run this file
-- separately if you'd rather not re-run the whole thing.
-- ============================================

USE booking_system;

CREATE TABLE IF NOT EXISTS product_time_slots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

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