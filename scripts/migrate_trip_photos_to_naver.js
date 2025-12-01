require('dotenv').config();
const axios = require('axios');
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// Naver Image Search
async function fetchNaverImage(query) {
    try {
        const response = await axios.get('https://openapi.naver.com/v1/search/image', {
            params: { query, display: 1, sort: 'sim' },
            headers: {
                'X-Naver-Client-Id': NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
            }
        });
        return response.data.items[0]?.link || null;
    } catch (err) {
        console.error(`Naver Image Search failed for "${query}":`, err.message);
        return null;
    }
}

async function migrateTripPhotos() {
    console.log('🚀 Starting migration of trip photos to Naver...\n');

    try {
        // 1. Get all trips from database
        const { data: trips, error: tripsError } = await supabase
            .from('trip_plans')
            .select('*')
            .order('created_at', { ascending: false });

        if (tripsError) throw tripsError;

        console.log(`📊 Found ${trips.length} trips in database\n`);

        let updatedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        // 2. Process each trip
        for (let i = 0; i < trips.length; i++) {
            const trip = trips[i];
            console.log(`[${i + 1}/${trips.length}] Processing: ${trip.itinerary_data?.trip_title || trip.destination}`);

            let hasChanges = false;
            const itineraryData = trip.itinerary_data;

            if (!itineraryData || !itineraryData.itinerary) {
                console.log(`  ⏭️ Skipped: No itinerary data\n`);
                skippedCount++;
                continue;
            }

            // 3. Check and replace Google Photo URLs in activities
            for (const day of itineraryData.itinerary) {
                for (const activity of day.activities || []) {
                    // Check if photoUrl is a Google Places API URL
                    if (activity.photoUrl && activity.photoUrl.includes('places.googleapis.com')) {
                        console.log(`  🔍 Found Google Photo URL: ${activity.place_name}`);

                        // Try to get Naver image
                        const naverImage = await fetchNaverImage(`${trip.destination} ${activity.place_name}`);

                        if (naverImage) {
                            activity.photoUrl = naverImage;
                            hasChanges = true;
                            console.log(`  ✅ Replaced with Naver image`);
                        } else {
                            // Fallback to Unsplash
                            activity.photoUrl = "https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?q=80&w=800&auto=format&fit=crop";
                            hasChanges = true;
                            console.log(`  ⚠️ Replaced with Unsplash fallback`);
                        }

                        // Add small delay to avoid rate limiting
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                }
            }

            // 4. Update trip in database if changes were made
            if (hasChanges) {
                const { error: updateError } = await supabase
                    .from('trip_plans')
                    .update({ itinerary_data: itineraryData })
                    .eq('id', trip.id);

                if (updateError) {
                    console.log(`  ❌ Update failed: ${updateError.message}`);
                    errorCount++;
                } else {
                    updatedCount++;
                    console.log(`  💾 Updated trip in database`);
                }
            } else {
                skippedCount++;
                console.log(`  ⏭️ No Google photos found`);
            }

            console.log('');
        }

        console.log(`\n🎉 Migration completed!`);
        console.log(`   Updated: ${updatedCount} trips`);
        console.log(`   Skipped: ${skippedCount} trips`);
        console.log(`   Errors: ${errorCount} trips`);

    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        console.error(error);
    }
}

// Run migration
migrateTripPhotos();
