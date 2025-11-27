-- Create places_cache table for storing Google Places API data
-- This reduces API costs by caching place details and photos
-- Run this SQL in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS places_cache (
  place_id TEXT PRIMARY KEY,
  place_name TEXT NOT NULL,
  rating REAL,
  rating_count INTEGER DEFAULT 0,
  google_maps_uri TEXT,
  website_uri TEXT,
  photo_url TEXT,
  location JSONB,
  types JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster queries by place name
CREATE INDEX IF NOT EXISTS idx_places_cache_name ON places_cache(place_name);

-- Comments for documentation
COMMENT ON TABLE places_cache IS 'Google Places API 데이터 캐시 테이블 - API 비용 절감용';
COMMENT ON COLUMN places_cache.place_id IS 'Google Place ID (Primary Key)';
COMMENT ON COLUMN places_cache.place_name IS '장소명 (예: 명동교자)';
COMMENT ON COLUMN places_cache.photo_url IS 'Google Places Photo URL (최대 400px)';
COMMENT ON COLUMN places_cache.created_at IS '캐시 생성 시간';
