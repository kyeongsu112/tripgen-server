require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 캐시된 모든 사진 URL을 초기화하여 새로 검색하도록 함
async function clearCachedPhotos() {
    console.log('🧹 Clearing all cached photo URLs...\n');

    try {
        // 1. 모든 캐시된 장소 가져오기
        const { data: places, error: fetchError } = await supabase
            .from('places_cache')
            .select('place_id, place_name, photo_url');

        if (fetchError) throw fetchError;

        console.log(`📊 Found ${places.length} places in cache\n`);

        // 2. 모든 photo_url을 null로 설정
        const { error: updateError, count } = await supabase
            .from('places_cache')
            .update({ photo_url: null, photo_reference: null })
            .neq('photo_url', null);

        if (updateError) throw updateError;

        console.log(`✅ Cleared photo URLs for ${count || places.length} places`);
        console.log('\n💡 Next time a trip is generated, fresh Naver images will be fetched.');

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

clearCachedPhotos();
