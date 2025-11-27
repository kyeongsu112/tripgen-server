-- =========================================
-- STEP 3: STEP 2 완료 후 이것을 실행하세요
-- 인덱스 생성
-- =========================================

-- trip_plans 인덱스
CREATE INDEX IF NOT EXISTS idx_trip_plans_user_id ON trip_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_trip_plans_created_at ON trip_plans(created_at DESC);

-- suggestions 인덱스
CREATE INDEX IF NOT EXISTS idx_suggestions_user_id ON suggestions(user_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_created_at ON suggestions(created_at DESC);

-- community 인덱스
CREATE INDEX IF NOT EXISTS idx_community_user_id ON community(user_id);
CREATE INDEX IF NOT EXISTS idx_community_created_at ON community(created_at DESC);

-- deleted_users 인덱스
CREATE INDEX IF NOT EXISTS idx_deleted_users_email ON deleted_users(email);

-- user_limits 인덱스
CREATE INDEX IF NOT EXISTS idx_user_limits_tier ON user_limits(tier);
CREATE INDEX IF NOT EXISTS idx_user_limits_ad_date ON user_limits(last_ad_watch_date);
