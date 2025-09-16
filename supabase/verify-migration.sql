-- Verification Script for GMB Database Migration
-- Run these commands to check if all changes were applied successfully

-- ============================================================================
-- 1. Check if new columns were added to social_media_posts
-- ============================================================================

-- Check table structure for social_media_posts
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'social_media_posts'
  AND column_name IN ('location_id', 'gmb_account_id')
ORDER BY column_name;

-- ============================================================================
-- 2. Check if GMB tables were created
-- ============================================================================

-- List all GMB-related tables
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_name LIKE '%gmb%'
  AND table_schema = 'public'
ORDER BY table_name;

-- ============================================================================
-- 3. Check gmb_accounts table structure
-- ============================================================================

-- Verify gmb_accounts table columns
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'gmb_accounts'
ORDER BY ordinal_position;

-- ============================================================================
-- 4. Check gmb_locations table structure
-- ============================================================================

-- Verify gmb_locations table columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'gmb_locations'
ORDER BY ordinal_position;

-- ============================================================================
-- 5. Check gmb_media_cache table structure
-- ============================================================================

-- Verify gmb_media_cache table columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'gmb_media_cache'
ORDER BY ordinal_position;

-- ============================================================================
-- 6. Check indexes were created
-- ============================================================================

-- List all GMB-related indexes
SELECT
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE indexname LIKE '%gmb%'
   OR indexname LIKE '%social_media_posts%'
ORDER BY tablename, indexname;

-- ============================================================================
-- 7. Check RLS policies were created
-- ============================================================================

-- List RLS policies for GMB tables
SELECT
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual
FROM pg_policies
WHERE tablename LIKE '%gmb%'
ORDER BY tablename, policyname;

-- ============================================================================
-- 8. Quick summary check
-- ============================================================================

-- Summary of what should exist
SELECT
    'Table Check' as check_type,
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gmb_accounts')
        THEN '✅ gmb_accounts exists'
        ELSE '❌ gmb_accounts missing'
    END as result
UNION ALL
SELECT
    'Table Check',
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gmb_locations')
        THEN '✅ gmb_locations exists'
        ELSE '❌ gmb_locations missing'
    END
UNION ALL
SELECT
    'Table Check',
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gmb_media_cache')
        THEN '✅ gmb_media_cache exists'
        ELSE '❌ gmb_media_cache missing'
    END
UNION ALL
SELECT
    'Column Check',
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'social_media_posts' AND column_name = 'location_id')
        THEN '✅ social_media_posts.location_id exists'
        ELSE '❌ social_media_posts.location_id missing'
    END
UNION ALL
SELECT
    'Column Check',
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'social_media_posts' AND column_name = 'gmb_account_id')
        THEN '✅ social_media_posts.gmb_account_id exists'
        ELSE '❌ social_media_posts.gmb_account_id missing'
    END;