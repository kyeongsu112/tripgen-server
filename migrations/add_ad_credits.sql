-- Add ad credit tracking columns to user_limits table
-- Run this SQL in Supabase SQL Editor

ALTER TABLE user_limits 
ADD COLUMN IF NOT EXISTS ad_credits INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_ad_date DATE,
ADD COLUMN IF NOT EXISTS daily_ad_count INTEGER DEFAULT 0;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_user_limits_ad_date ON user_limits(last_ad_date);

-- Comment for documentation
COMMENT ON COLUMN user_limits.ad_credits IS '광고 시청으로 획득한 추가 생성 크레딧';
COMMENT ON COLUMN user_limits.last_ad_date IS '마지막 광고 시청 날짜';
COMMENT ON COLUMN user_limits.daily_ad_count IS '오늘 시청한 광고 횟수 (최대 3회)';
