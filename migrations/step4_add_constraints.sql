-- =========================================
-- STEP 4 (선택): STEP 3 완료 후 실행
-- Foreign Key 제약 조건 및 코멘트
-- =========================================

-- Foreign Keys
ALTER TABLE trip_plans
DROP CONSTRAINT IF EXISTS fk_trip_plans_user_id;

ALTER TABLE trip_plans
ADD CONSTRAINT fk_trip_plans_user_id
FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE user_limits
DROP CONSTRAINT IF EXISTS fk_user_limits_user_id;

ALTER TABLE user_limits
ADD CONSTRAINT fk_user_limits_user_id
FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE community
DROP CONSTRAINT IF EXISTS fk_community_user_id;

ALTER TABLE community
ADD CONSTRAINT fk_community_user_id
FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE suggestions
DROP CONSTRAINT IF EXISTS fk_suggestions_user_id;

ALTER TABLE suggestions
ADD CONSTRAINT fk_suggestions_user_id
FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Comments
COMMENT ON TABLE trip_plans IS '사용자 여행 일정 저장';
COMMENT ON COLUMN trip_plans.itinerary_data IS '일정 상세 정보 (JSON)';

COMMENT ON TABLE suggestions IS '건의사항 및 피드백';

COMMENT ON TABLE community IS '커뮤니티 게시판 - 여행 이야기 공유';
COMMENT ON COLUMN community.is_anonymous IS '익명 게시글 여부';

COMMENT ON TABLE deleted_users IS '탈퇴한 사용자 기록 (재가입 방지)';

COMMENT ON TABLE user_limits IS '사용자 사용량 및 등급 관리';
COMMENT ON COLUMN user_limits.tier IS '사용자 등급 (free, pro, admin)';
COMMENT ON COLUMN user_limits.usage_count IS '월간 사용 횟수';
COMMENT ON COLUMN user_limits.ad_credits IS '광고 시청으로 획득한 크레딧';
COMMENT ON COLUMN user_limits.daily_ad_count IS '일일 광고 시청 횟수 (최대 2회)';
