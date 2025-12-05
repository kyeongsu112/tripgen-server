require('dotenv').config();
const axios = require('axios');

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

async function testSearchLogic(query) {
    console.log(`🧪 Testing search for: "${query}"`);

    const trySearch = async (q) => {
        try {
            console.log(`   Trying Naver search: "${q}"`);
            const response = await axios.get('https://openapi.naver.com/v1/search/image', {
                params: { query: q, display: 1, sort: 'sim', filter: 'large' },
                headers: {
                    'X-Naver-Client-Id': NAVER_CLIENT_ID,
                    'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
                }
            });
            if (response.data.items && response.data.items.length > 0) {
                return response.data.items[0].link;
            }
        } catch (e) {
            console.log(`   ❌ Search failed for "${q}"`);
        }
        return null;
    };

    // 1. 원본 검색
    let result = await trySearch(query);
    if (result) {
        console.log(`   ✅ Found with original query!`);
        return result;
    }

    // 2. "by ..." 패턴 제거 로직 테스트
    if (query.toLowerCase().includes(' by ')) {
        const simplified = query.replace(/\s+by\s+.*$/i, '');
        console.log(`   🔄 Detected 'by' pattern. Simplified to: "${simplified}"`);

        result = await trySearch(simplified);
        if (result) {
            console.log(`   ✅ Found with simplified query!`);
            return result;
        }

        result = await trySearch(`${simplified} hotel`);
        if (result) {
            console.log(`   ✅ Found with simplified + hotel!`);
            return result;
        }
    }

    console.log(`   ❌ Failed to find image.`);
    return null;
}

// 테스트 실행
testSearchLogic("L7 MYEONGDONG by LOTTE");
