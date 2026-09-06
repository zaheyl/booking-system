-- ============================================
-- TIME EXCLUSIONS MIGRATION
--   mysql -u root -p booking_system < schema-time-exclusions.sql
--
-- Adds optional excluded_start_time / excluded_end_time to
-- product_date_exclusions, so a blocked date can record which specific
-- hours were blocked (mainly useful in Hours mode). NULL still means
-- the whole day is blocked, exactly as before this migration.
--
-- This is already folded into the main schema.sql — only run this file
-- separately if you'd rather not re-run the whole thing.
-- ============================================

USE booking_system;

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