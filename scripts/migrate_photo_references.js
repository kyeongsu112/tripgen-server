require('dotenv').config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function migratePhotoReferences() {
    console.log('🚀 Starting migration of photo references...\n');

    try {
        // 1. 모든 캐시된 장소 가져오기
        const { data: places, error: placesError } = await supabase
            .from('places_cache')
            .select('*');

        if (placesError) throw placesError;

        console.log(`📊 Found ${places.length} places in cache\n`);

        let updatedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        // 2. 각 장소 처리
        for (let i = 0; i < places.length; i++) {
            const place = places[i];

            // 이미 photo_reference가 있으면 스킵
            if (place.photo_reference) {
                skippedCount++;
                continue;
            }

            // photo_url에서 reference 추출
            // URL 형식: https://places.googleapis.com/v1/places/PLACE_ID/photos/PHOTO_ID/media?...
            // 추출 대상: places/PLACE_ID/photos/PHOTO_ID
            if (place.photo_url) {
                const match = place.photo_url.match(/places\/[^/]+\/photos\/[^/]+/);

                if (match) {
                    const photoReference = match[0];

                    const { error: updateError } = await supabase
                        .from('places_cache')
                        .update({ photo_reference: photoReference })
                        .eq('place_id', place.place_id);

                    if (updateError) {
                        console.log(`❌ Update failed for ${place.place_name}: ${updateError.message}`);
                        errorCount++;
                    } else {
                        updatedCount++;
                        console.log(`✅ Updated ${place.place_name}: ${photoReference}`);
                    }
                } else {
                    console.log(`⚠️ No reference found in URL for ${place.place_name}`);
                    skippedCount++;
                }
            } else {
                skippedCount++;
            }
        }

        console.log(`\n🎉 Migration completed!`);
        console.log(`   Updated: ${updatedCount} places`);
        console.log(`   Skipped: ${skippedCount} places`);
        console.log(`   Errors: ${errorCount} places`);

    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        console.error(error);
    }
}

// 실행
migratePhotoReferences();
