require('dotenv').config();
const axios = require('axios');
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

async function enrichPlacesCache() {
    console.log('🚀 Starting enrichment of places_cache...\n');

    try {
        // 1. 모든 캐시된 장소 가져오기
        const { data: places, error: placesError } = await supabase
            .from('places_cache')
            .select('*');

        if (placesError) throw placesError;

        console.log(`📊 Found ${places.length} places in cache\n`);

        let enrichedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        // 2. 각 장소 보강
        for (let i = 0; i < places.length; i++) {
            const place = places[i];
            const updates = {};
            let needsUpdate = false;

            console.log(`[${i + 1}/${places.length}] Processing: ${place.place_name}`);

            // search_keywords 보강
            if (!place.search_keywords || place.search_keywords === place.place_name) {
                // 기존 place_name과 함께 저장
                updates.search_keywords = place.place_name;
                needsUpdate = true;
                console.log(`  ✨ Updated search_keywords`);
            }

            // location이 없는 경우 Google Places API 호출
            if (!place.location && place.place_id) {
                try {
                    console.log(`  🔍 Fetching missing location from Google Places API...`);

                    const response = await axios.post(
                        `https://places.googleapis.com/v1/places/${place.place_id}`,
                        {},
                        {
                            headers: {
                                "Content-Type": "application/json",
                                "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
                                "X-Goog-FieldMask": "id,location,rating,userRatingCount,googleMapsUri,websiteUri,types,displayName,photos"
                            }
                        }
                    );

                    const placeData = response.data;

                    if (placeData.location) {
                        updates.location = placeData.location;
                        needsUpdate = true;
                        console.log(`  ✅ Added location: (${placeData.location.latitude}, ${placeData.location.longitude})`);
                    }

                    if (placeData.rating && !place.rating) {
                        updates.rating = placeData.rating;
                        needsUpdate = true;
                    }

                    if (placeData.userRatingCount && !place.rating_count) {
                        updates.rating_count = placeData.userRatingCount;
                        needsUpdate = true;
                    }

                    if (placeData.photos && placeData.photos.length > 0 && !place.photo_url) {
                        const photoReference = placeData.photos[0].name;
                        updates.photo_url = `https://places.googleapis.com/v1/${photoReference}/media?key=${GOOGLE_MAPS_API_KEY}&maxHeightPx=800&maxWidthPx=800`;
                        needsUpdate = true;
                        console.log(`  📷 Added photo URL`);
                    }

                    if (placeData.types && (!place.types || place.types.length === 0)) {
                        updates.types = placeData.types;
                        needsUpdate = true;
                    }

                    // API 호출 제한을 위한 짧은 대기
                    await new Promise(resolve => setTimeout(resolve, 100));

                } catch (apiError) {
                    console.log(`  ⚠️ API Error: ${apiError.message}`);
                    errorCount++;
                }
            }

            // DB 업데이트
            if (needsUpdate) {
                const { error: updateError } = await supabase
                    .from('places_cache')
                    .update(updates)
                    .eq('place_id', place.place_id);

                if (updateError) {
                    console.log(`  ❌ Update failed: ${updateError.message}`);
                    errorCount++;
                } else {
                    enrichedCount++;
                    console.log(`  💾 Saved updates`);
                }
            } else {
                skippedCount++;
                console.log(`  ⏭️ No updates needed`);
            }

            console.log('');
        }

        console.log(`\n🎉 Enrichment completed!`);
        console.log(`   Enriched: ${enrichedCount} places`);
        console.log(`   Skipped: ${skippedCount} places`);
        console.log(`   Errors: ${errorCount} places`);

    } catch (error) {
        console.error('\n❌ Enrichment failed:', error.message);
        console.error(error);
    }
}

// 실행
enrichPlacesCache();
