require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchNaverImage(query) {
    try {
        const response = await axios.get('https://openapi.naver.com/v1/search/image', {
            params: { query: query, display: 1, sort: 'sim' },
            headers: {
                'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
            }
        });
        if (response.data.items && response.data.items.length > 0) {
            return response.data.items[0].link;
        }
    } catch (error) {
        console.error(`⚠️ Naver Image Search Failed for ${query}:`, error.message);
    }
    return null;
}

async function updateCache() {
    console.log("🔄 Starting Cache Update...");

    // 1. Get all cached places
    const { data: places, error } = await supabase.from('places_cache').select('*');
    if (error) {
        console.error("Failed to fetch cache:", error);
        return;
    }

    console.log(`Found ${places.length} places in cache.`);

    for (const place of places) {
        // Check if it needs update (e.g., has Google Photo URL or no URL)
        // We want to replace ALL Google URLs with Naver URLs to save cost/quota if we view them again? 
        // Actually, Google URLs expire, so replacing them is good.
        // Also fill missing URLs.

        // Extract city context from search_keywords or just use place_name
        // search_keywords usually contains "PlaceName|PlaceName|Address"
        // We can try to extract a city from address if possible, but for now let's just use the address part if available.

        let query = place.place_name;
        if (place.search_keywords) {
            const parts = place.search_keywords.split('|');
            // Usually the last part is address
            if (parts.length > 1) {
                const address = parts[parts.length - 1];
                // Simple extraction of city (e.g., "Seoul", "Jeju") might be hard, so let's just append the full address for context
                // But Naver search might fail if query is too long.
                // Let's try "PlaceName Address"
                query = `${place.place_name} ${address}`;
            }
        }

        console.log(`Processing: ${place.place_name} (Query: ${query})`);

        const newUrl = await fetchNaverImage(query);
        if (newUrl) {
            const { error: updateError } = await supabase
                .from('places_cache')
                .update({ photo_url: newUrl })
                .eq('place_id', place.place_id);

            if (updateError) console.error(`❌ Failed to update ${place.place_name}:`, updateError);
            else console.log(`✅ Updated: ${place.place_name}`);
        } else {
            console.log(`⚠️ No image found for: ${place.place_name}`);
        }

        // Rate limit prevention (Naver limit is high but good practice)
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log("🎉 Cache Update Complete!");
}

updateCache();
