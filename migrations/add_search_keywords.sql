-- Enable pg_trgm extension for fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add search_keywords column to places_cache table
ALTER TABLE places_cache 
ADD COLUMN IF NOT EXISTS search_keywords TEXT;

-- Create index for faster searching
CREATE INDEX IF NOT EXISTS idx_places_cache_search_keywords ON places_cache USING gin(search_keywords gin_trgm_ops);
