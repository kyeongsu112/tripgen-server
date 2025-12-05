const cron = require('node-cron');
const axios = require('axios');
const { createClient } = require("@supabase/supabase-js");

// 환경 변수 로드 (server.js에서 호출되므로 process.env 사용 가능)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// Naver Image Search Function
async function fetchNaverImage(query) {
    try {
        const response = await axios.get('https://openapi.naver.com/v1/search/image', {
            params: { query: query, display: 1, sort: 'sim', filter: 'large' },
            headers: {
                'X-Naver-Client-Id': NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
            }
        });

        if (response.data.items && response.data.items.length > 0) {
            return response.data.items[0].link;
        }
    } catch (err) {
        console.error(`⚠️ Naver Search failed for "${query}":`, err.message);
    }
    return null;
}

// 이미지 URL 유효성 검사 (HEAD 요청)
async function isImageValid(url) {
    if (!url) return false;
    try {
        await axios.head(url, { timeout: 5000 });
        return true;
    } catch (error) {
        return false;
    }
}

async function runImageHealthCheck() {
    console.log('⏰ [Cron] Starting Weekly Image Health Check...');

    try {
        // 1. 모든 캐시된 장소 가져오기
        const { data: places, error } = await supabase
            .from('places_cache')
            .select('*')
            .not('photo_url', 'is', null);

        if (error) throw error;

        console.log(`📊 Checking ${places.length} images...`);
        let fixedCount = 0;
        let errorCount = 0;

        // 2. 순차적으로 검사 (서버 부하 방지)
        for (let i = 0; i < places.length; i++) {
            const place = places[i];

            // 유효성 검사
            const isValid = await isImageValid(place.photo_url);

            if (!isValid) {
                console.log(`   ❌ Broken link detected: ${place.place_name}`);

                // 재검색 시도
                const newPhotoUrl = await fetchNaverImage(place.place_name);

                if (newPhotoUrl) {
                    await supabase
                        .from('places_cache')
                        .update({ photo_url: newPhotoUrl })
                        .eq('place_id', place.place_id);
                    console.log(`   ✅ Fixed -> ${newPhotoUrl.substring(0, 30)}...`);
                    fixedCount++;
                } else {
                    console.log(`   ⚠️ Failed to find replacement.`);
                    errorCount++;
                }
            }

            // Rate Limit 방지 (약간의 딜레이)
            if (i % 10 === 0) await new Promise(r => setTimeout(r, 100));
        }

        console.log(`🎉 [Cron] Health Check Complete! Fixed: ${fixedCount}, Errors: ${errorCount}`);

    } catch (err) {
        console.error('❌ [Cron] Error:', err.message);
    }
}

// 스케줄러 설정 함수
function startImageScheduler() {
    // 매주 일요일 새벽 4시 0분에 실행 (0 4 * * 0)
    cron.schedule('0 4 * * 0', () => {
        runImageHealthCheck();
    });
    console.log('📅 Image Health Check Scheduler is running (Every Sunday 04:00 AM)');
}

module.exports = { startImageScheduler, runImageHealthCheck };
