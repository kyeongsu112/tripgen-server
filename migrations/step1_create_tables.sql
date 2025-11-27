-- =========================================
-- STEP 1: 먼저 이것만 실행하세요
-- 기본 테이블만 생성 (인덱스 제외)
-- =========================================

-- trip_plans 테이블
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

-- suggestions 테이블
CREATE TABLE IF NOT EXISTS suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,
  email TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- community 테이블
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

-- deleted_users 테이블
CREATE TABLE IF NOT EXISTS deleted_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL,
  deleted_at TIMESTAMPTZ DEFAULT NOW()
);

-- user_limits 테이블 (기본 구조만)
CREATE TABLE IF NOT EXISTS user_limits (
  user_id UUID PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  usage_count INTEGER DEFAULT 0,
  last_reset_date TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
