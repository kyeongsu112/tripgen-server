-- =========================================
-- TripGen Core Tables Migration (단계별)
-- user_limits 테이블이 이미 존재하는 경우
-- =========================================

-- STEP 1: 기본 테이블만 생성 (user_limits 제외)
-- =========================================

-- 1. trip_plans 테이블 (여행 일정 저장)
CREATE TABLE IF NOT EXISTS trip_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  destination TEXT NOT NULL,
  duration TEXT NOT NULL,
  style TEXT,
  companions TEXT,
  itinerary_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_plans_user_id ON trip_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_trip_plans_created_at ON trip_plans(created_at DESC);

COMMENT ON TABLE trip_plans IS '사용자 여행 일정 저장';
COMMENT ON COLUMN trip_plans.itinerary_data IS '일정 상세 정보 (JSON)';

-- 2. suggestions 테이블 (건의사항)
CREATE TABLE IF NOT EXISTS suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,
  email TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suggestions_user_id ON suggestions(user_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_created_at ON suggestions(created_at DESC);

COMMENT ON TABLE suggestions IS '건의사항 및 피드백';

-- 3. community 테이블 (커뮤니티 게시판)
CREATE TABLE IF NOT EXISTS community (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,
  email TEXT,
  nickname TEXT NOT NULL DEFAULT '익명',
  content TEXT NOT NULL,
  is_anonymous BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_user_id ON community(user_id);
CREATE INDEX IF NOT EXISTS idx_community_created_at ON community(created_at DESC);

COMMENT ON TABLE community IS '커뮤니티 게시판 - 여행 이야기 공유';
COMMENT ON COLUMN community.is_anonymous IS '익명 게시글 여부';

-- 4. deleted_users 테이블 (탈퇴 사용자 기록)
CREATE TABLE IF NOT EXISTS deleted_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL,
  deleted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deleted_users_email ON deleted_users(email);

COMMENT ON TABLE deleted_users IS '탈퇴한 사용자 기록 (재가입 방지)';

-- =========================================
-- STEP 2: user_limits 테이블 수정
-- (기존 테이블에 컬럼 추가)
-- =========================================

-- user_limits 테이블이 없으면 생성
CREATE TABLE IF NOT EXISTS user_limits (
  user_id UUID PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  usage_count INTEGER DEFAULT 0,
  last_reset_date TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 광고 관련 컬럼 추가 (이미 있으면 무시)
ALTER TABLE user_limits 
ADD COLUMN IF NOT EXISTS ad_credits INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_ad_watch_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS daily_ad_count INTEGER DEFAULT 0;

-- 인덱스 생성 (이제 컬럼이 존재함)
CREATE INDEX IF NOT EXISTS idx_user_limits_tier ON user_limits(tier);
CREATE INDEX IF NOT EXISTS idx_user_limits_ad_date ON user_limits(last_ad_watch_date);

-- 코멘트
COMMENT ON TABLE user_limits IS '사용자 사용량 및 등급 관리';
COMMENT ON COLUMN user_limits.tier IS '사용자 등급 (free, pro, admin)';
COMMENT ON COLUMN user_limits.usage_count IS '월간 사용 횟수';
COMMENT ON COLUMN user_limits.ad_credits IS '광고 시청으로 획득한 크레딧';
COMMENT ON COLUMN user_limits.daily_ad_count IS '일일 광고 시청 횟수 (최대 2회)';

-- =========================================
-- STEP 3: Foreign Key 제약 조건
-- =========================================

-- trip_plans.user_id → auth.users.id
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_trip_plans_user_id'
  ) THEN
    ALTER TABLE trip_plans
    ADD CONSTRAINT fk_trip_plans_user_id
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- user_limits.user_id → auth.users.id
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_limits_user_id'
  ) THEN
    ALTER TABLE user_limits
    ADD CONSTRAINT fk_user_limits_user_id
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- community.user_id → auth.users.id (NULL 허용)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_community_user_id'
  ) THEN
    ALTER TABLE community
    ADD CONSTRAINT fk_community_user_id
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- suggestions.user_id → auth.users.id (NULL 허용)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_suggestions_user_id'
  ) THEN
    ALTER TABLE suggestions
    ADD CONSTRAINT fk_suggestions_user_id
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =========================================
-- 완료 메시지
-- =========================================
SELECT 'TripGen 핵심 테이블 생성 완료!' AS message;
