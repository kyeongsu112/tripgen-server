require('dotenv').config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function migrateExistingDataToCache() {
    console.log('🚀 Starting migration of existing trip data to places_cache...\n');

    try {
        // 1. 모든 trip_plans 가져오기
        const { data: trips, error: tripsError } = await supabase
            .from('trip_plans')
            .select('*');

        if (tripsError) throw tripsError;

        console.log(`📊 Found ${trips.length} trips to process\n`);

        let totalPlaces = 0;
        let cachedPlaces = 0;
        let skippedPlaces = 0;

        const placesToCache = new Map(); // place_id를 키로 사용하여 중복 제거

        // 2. 각 trip에서 장소 정보 추출
        for (const trip of trips) {
            const itinerary = trip.itinerary_data?.itinerary || [];

            for (const day of itinerary) {
                const activities = day.activities || [];

                for (const activity of activities) {
                    totalPlaces++;

                    // 필수 정보가 없는 경우 스킵
                    if (!activity.place_id || !activity.place_name) {
                        skippedPlaces++;
                        continue;
                    }

                    // 숙소/이동 항목 스킵
                    if (activity.place_name.includes('이동') ||
                        activity.place_name.includes('숙소') ||
                        activity.place_name.includes('체크인')) {
                        skippedPlaces++;
                        continue;
                    }

                    // 중복 체크 (place_id 기준)
                    if (!placesToCache.has(activity.place_id)) {
                        placesToCache.set(activity.place_id, {
                            place_id: activity.place_id,
                            place_name: activity.place_name,
                            search_keywords: activity.place_name, // 기본값으로 place_name 사용
                            rating: typeof activity.rating === 'number' ? activity.rating : null,
                            rating_count: activity.ratingCount || 0,
                            google_maps_uri: activity.googleMapsUri || activity.google_maps_uri || null,
                            website_uri: activity.websiteUri || activity.website_uri || null,
                            photo_url: activity.photoUrl || activity.photo_url || null,
                            location: activity.location || null,
                            types: activity.types || []
                        });
                    }
                }
            }
        }

        console.log(`\n📈 Statistics:`);
        console.log(`   Total activities: ${totalPlaces}`);
        console.log(`   Skipped (no data/movement): ${skippedPlaces}`);
        console.log(`   Unique places to cache: ${placesToCache.size}\n`);

        // 3. places_cache에 삽입 (배치 처리)
        const placesArray = Array.from(placesToCache.values());
        const batchSize = 50;

        for (let i = 0; i < placesArray.length; i += batchSize) {
            const batch = placesArray.slice(i, i + batchSize);

            const { data, error } = await supabase
                .from('places_cache')
                .upsert(batch, { onConflict: 'place_id' })
                .select();

            if (error) {
                console.error(`❌ Error inserting batch ${i / batchSize + 1}:`, error.message);
            } else {
                cachedPlaces += batch.length;
                console.log(`✅ Cached batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(placesArray.length / batchSize)} (${batch.length} places)`);
            }
        }

        console.log(`\n🎉 Migration completed!`);
        console.log(`   Successfully cached: ${cachedPlaces} places`);
        console.log(`\n💡 Tip: You can now run this script anytime to update the cache with new trip data.`);

    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        console.error(error);
    }
}

// 실행
migrateExistingDataToCache();
