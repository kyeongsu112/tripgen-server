-- =========================================
-- STEP 2: STEP 1 완료 후 이것을 실행하세요
-- 광고 관련 컬럼 추가
-- =========================================

-- user_limits에 광고 관련 컬럼 추가
ALTER TABLE user_limits 
ADD COLUMN IF NOT EXISTS ad_credits INTEGER DEFAULT 0;

ALTER TABLE user_limits 
ADD COLUMN IF NOT EXISTS last_ad_watch_date TIMESTAMPTZ;

ALTER TABLE user_limits 
ADD COLUMN IF NOT EXISTS daily_ad_count INTEGER DEFAULT 0;
