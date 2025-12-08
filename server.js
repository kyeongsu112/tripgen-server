require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
// Render 배포 환경 호환
const PORT = process.env.PORT || 8080;

// Helper function for delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 대용량 데이터 처리를 위해 limit 설정 증가
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- [설정 확인 및 초기화] ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. 일반 클라이언트 (조회 및 본인 데이터 수정용)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
// 2. 관리자 클라이언트 (회원 삭제 및 관리자 권한 작업용 - Service Role Key 필수)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
// 관리자 이메일
const ADMIN_EMAIL = process.env.NEXT_PUBLIC_ADMIN_EMAIL;
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || "http://localhost:8080";

const TIER_LIMITS = { free: 5, pro: 30, admin: Infinity };
const FALLBACK_IMAGE_URL = "https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?q=80&w=800&auto=format&fit=crop";

const FALLBACK_IMAGES = {
  food: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=800&auto=format&fit=crop",
  nature: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?q=80&w=800&auto=format&fit=crop",
  city: "https://images.unsplash.com/photo-1449824913935-59a10b8d2000?q=80&w=800&auto=format&fit=crop",
  culture: "https://images.unsplash.com/photo-1566073771259-6a8506099945?q=80&w=800&auto=format&fit=crop",
  hotel: "https://images.unsplash.com/photo-1566073771259-6a8506099945?q=80&w=800&auto=format&fit=crop"
};

function getFallbackImage(types = []) {
  if (!types || types.length === 0) return FALLBACK_IMAGES.default || FALLBACK_IMAGE_URL;
  if (types.some(t => ['restaurant', 'food', 'cafe', 'bar', 'bakery', 'meal_takeaway'].includes(t))) return FALLBACK_IMAGES.food;
  if (types.some(t => ['park', 'campground', 'natural_feature', 'amusement_park'].includes(t))) return FALLBACK_IMAGES.nature;
  if (types.some(t => ['museum', 'art_gallery', 'church', 'place_of_worship', 'library', 'university'].includes(t))) return FALLBACK_IMAGES.culture;
  if (types.some(t => ['lodging', 'hotel', 'guest_house'].includes(t))) return FALLBACK_IMAGES.hotel;
  return FALLBACK_IMAGES.city;
}

// --- [Optimization] Global In-Memory Cache (with Memory Safety) ---
const placeDetailsCache = new Map();
const MAX_CACHE_SIZE = 1000; // Prevent memory leak

function addToCache(key, value) {
  if (placeDetailsCache.size >= MAX_CACHE_SIZE) {
    placeDetailsCache.clear(); // Simple strategy: clear all if full
    console.log("🧹 Global Cache Cleared (Size Limit Reached)");
  }
  placeDetailsCache.set(key, value);
}

// --- [Helpers] ---
function calculateDays(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffTime = Math.abs(endDate - startDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
}

function cleanAndParseJSON(text) {
  try {
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("JSON Parse Error:", e);
    return null;
  }
}

// 네이버 이미지 검색 (Naver Search API) - 개선된 버전
async function fetchNaverImage(query, retryWithKeywords = true) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  // 🔧 부적절한 이미지 URL 필터 + Hotlink Protection 도메인 차단
  const isValidImageUrl = (url) => {
    if (!url) return false;
    const badPatterns = [
      'profile', 'avatar', 'user', 'thumbnail', 'icon',
      'logo', 'banner', 'advertisement', 'ad_', 'spotify',
      'album', 'cover', 'music', 'person', 'people',
      // Hotlink Protection 의심 도메인 (외부 로딩 차단)
      'exp.cdn-hotels.com', 'tripadvisor', 'agoda', 'booking.com', 'hotels.com',
      // 네이버 뉴스 이미지는 외부 로딩 차단될 수 있음
      'imgnews.naver.net', 'news.naver.com'
    ];
    const lowerUrl = url.toLowerCase();
    return !badPatterns.some(pattern => lowerUrl.includes(pattern));
  };

  const trySearch = async (searchQuery) => {
    try {
      const response = await axios.get('https://openapi.naver.com/v1/search/image', {
        params: { query: searchQuery, display: 10, sort: 'sim', filter: 'large' },
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
      });
      if (response.data.items && response.data.items.length > 0) {
        // 1. 네이버 호스팅 이미지 우선 (pstatic.net, blog.naver 등) - 차단 안됨
        for (const item of response.data.items) {
          if (item.link.includes('pstatic.net') || item.link.includes('blog.naver.com') || item.link.includes('post.naver.com')) {
            if (isValidImageUrl(item.link)) return item.link;
          }
        }

        // 2. 그 외 유효한 이미지
        for (const item of response.data.items) {
          if (isValidImageUrl(item.link)) {
            return item.link;
          }
        }

        // 3. 정 없으면 썸네일이라도 반환
        if (response.data.items[0].thumbnail) {
          return response.data.items[0].thumbnail;
        }

        // 필터 통과 못하면 첫 번째 결과 반환
        return response.data.items[0].link;
      }
    } catch (error) {
      console.error(`Naver Image Search Error for ${searchQuery}:`, error.message);
    }
    return null;
  };

  // 1차 시도: 원본 쿼리
  let result = await trySearch(query);
  if (result) return result;

  // 1차 시도: 원본 쿼리 (이미 위에서 선언됨)
  // let result = await trySearch(query); // REMOVED
  // if (result) return result; // REMOVED

  // 2차 시도: "by ..." 패턴 제거 (예: "L7 MYEONGDONG by LOTTE" -> "L7 MYEONGDONG")
  if (query.toLowerCase().includes(' by ')) {
    const simplifiedQuery = query.replace(/\s+by\s+.*$/i, '');
    console.log(`🔄 Retrying with simplified query: ${simplifiedQuery}`);
    result = await trySearch(simplifiedQuery);
    if (result) return result;

    // 단순화된 쿼리에 "호텔" 등 키워드 추가 재시도
    result = await trySearch(`${simplifiedQuery} hotel`);
    if (result) return result;
  }

  // 3차 시도: 여행/관광 키워드 추가
  if (retryWithKeywords) {
    const travelKeywords = ['여행 사진', '관광 명소', '풍경 사진', '호텔'];
    for (const keyword of travelKeywords) {
      result = await trySearch(`${query} ${keyword}`);
      if (result) {
        console.log(`📸 Found image with keyword: ${query} ${keyword}`);
        return result;
      }
    }
  }

  return null;
}

// 장소 상세 정보 조회 (Cache -> Naver Image -> Google API)
async function fetchPlaceDetails(placeName, cityContext = "") {
  if (placeName.includes("체크인") || placeName.includes("숙소") || placeName.includes("복귀")) {
    return {
      place_name: placeName,
      type: "숙소",
      photoUrl: getFallbackImage(['lodging', 'hotel'])
    };
  }

  // [1] Check Memory Cache
  if (placeDetailsCache.has(placeName)) {
    return placeDetailsCache.get(placeName);
  }

  // [2] Check DB Cache (Supabase)
  const { data: cachedPlace } = await supabase
    .from('places_cache')
    .select('*')
    .or(`place_name.eq.${placeName},search_keywords.ilike.%${placeName}%`)
    .limit(1)
    .maybeSingle();

  if (cachedPlace) {
    placeDetailsCache.set(placeName, cachedPlace);

    // [Self-Healing] 이미지가 없으면 다시 찾아 채워넣음 (Naver -> Google)
    if (!cachedPlace.photo_url) {
      console.log(`🩹 Healing missing photo for cached place: ${placeName}`);
      const cityContext = ""; // Context is hard to guess here, utilizing placeName only

      // 1. Try Naver First
      // 💡 검색어 조합: "도시명 + 장소명"이 가장 정확함 (여기서는 placeName만 사용)
      const naverImage = await fetchNaverImage(placeName);

      let newPhotoUrl = naverImage;
      let newPhotoReference = null;

      // 2. Fallback to Google Photos if Naver fails
      if (!newPhotoUrl) {
        try {
          const googleRes = await axios.post(
            `https://places.googleapis.com/v1/places:searchText`,
            { textQuery: placeName, languageCode: "ko" },
            {
              headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
                "X-Goog-FieldMask": "places.photos"
              }
            }
          );
          const place = googleRes.data.places && googleRes.data.places[0];
          if (place && place.photos && place.photos.length > 0) {
            newPhotoReference = place.photos[0].name;
            newPhotoUrl = `/api/proxy/google-photo/${newPhotoReference}`;
            console.log(`📸 Healing success (Google) for: ${placeName}`);
          }
        } catch (e) {
          console.error(`Healing Google Fallback Error for ${placeName}:`, e.message);
        }
      }

      // 3. Update DB if we found something
      if (newPhotoUrl) {
        cachedPlace.photo_url = newPhotoUrl;
        cachedPlace.photo_reference = newPhotoReference; // Update reference too if found

        // 비동기 업데이트
        supabase.from('places_cache')
          .update({
            photo_url: newPhotoUrl,
            photo_reference: newPhotoReference
          })
          .eq('place_id', cachedPlace.place_id)
          .then(({ error }) => {
            if (!error) console.log("🔄 Updated cached photo URL for:", placeName);
          });
      }
    }

    // 🔧 [Fix] DB 필드명(snake_case)을 프론트엔드 필드명(camelCase)으로 변환
    return {
      place_id: cachedPlace.place_id,
      place_name: cachedPlace.place_name,
      rating: cachedPlace.rating,
      ratingCount: cachedPlace.rating_count,
      googleMapsUri: cachedPlace.google_maps_uri,
      websiteUri: cachedPlace.website_uri,
      photoUrl: cachedPlace.photo_url,  // ✅ photo_url → photoUrl
      photoReference: cachedPlace.photo_reference,
      location: cachedPlace.location,
      types: cachedPlace.types
    };
  }

  // [3] Google Places API Call (텍스트 정보만! 사진 X)
  try {
    // 🔧 [Fix] 도시 컨텍스트를 검색어 앞에 배치하여 지역 바이어스 강화
    // "타임스퀘어 뉴욕" 대신 "뉴욕 타임스퀘어"로 검색 = 더 정확한 결과
    const placeSearchQuery = cityContext
      ? `${cityContext} ${placeName}`
      : placeName;

    console.log(`🔍 Google Places Search: ${placeSearchQuery}`);

    const response = await axios.post(
      `https://places.googleapis.com/v1/places:searchText`,
      { textQuery: placeSearchQuery, languageCode: "ko" },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
          // 🚨 photos 필드 제외 확인 (비용 절감)
          "X-Goog-FieldMask": "places.id,places.rating,places.userRatingCount,places.googleMapsUri,places.location,places.websiteUri,places.types,places.displayName,places.formattedAddress"
        }
      }
    );

    const place = response.data.places && response.data.places[0];
    if (!place) {
      return {
        place_name: placeName,
        photoUrl: getFallbackImage()
      };
    }

    console.log(`📍 API Search Result: ${place.displayName?.text}`);

    // [4] Naver Image Search (Primary)
    const searchName = place.displayName?.text || placeName;
    const isEnglishName = /^[A-Za-z\s\-']+$/.test(searchName);

    const getSearchSuffix = (types = []) => {
      if (types.some(t => ['restaurant', 'food', 'cafe', 'bar', 'bakery', 'meal_takeaway'].includes(t))) return " 맛집 음식 사진";
      if (types.some(t => ['tourist_attraction', 'point_of_interest', 'landmark', 'museum'].includes(t))) return " 관광명소 사진";
      if (types.some(t => ['park', 'natural_feature'].includes(t))) return " 공원 풍경 사진";
      if (types.some(t => ['lodging', 'hotel', 'guest_house'].includes(t))) return " 호텔 외관 사진";
      if (types.some(t => ['shopping_mall', 'store'].includes(t))) return " 쇼핑몰 내부 사진";
      return " 관광 사진";
    };

    const suffix = getSearchSuffix(place.types);

    // 영어 이름일 경우 도시 컨텍스트 필수 + 한글 키워드 강화
    let searchQuery;
    if (isEnglishName && cityContext) {
      searchQuery = `${cityContext} ${searchName}${suffix}`;
    } else if (isEnglishName) {
      // 도시 컨텍스트 없으면 "여행"으로 검색
      searchQuery = `${searchName}${suffix}`;
    } else {
      searchQuery = cityContext ? `${cityContext} ${searchName}${suffix}` : `${searchName}${suffix}`;
    }

    console.log(`🔍 Naver Search Query: ${searchQuery}`);
    let photoUrl = await fetchNaverImage(searchQuery);

    // [5] Fallback: Generic Image (Google Photos Removed for Cost)
    // 만약 네이버 이미지를 못 찾았다면? -> Fallback 이미지 사용
    if (!photoUrl) {
      photoUrl = getFallbackImage(place.types);
    }

    const placeData = {
      place_id: place.id,
      place_name: searchName, // 정제된 구글 장소명 사용
      rating: place.rating,
      ratingCount: place.userRatingCount,
      googleMapsUri: place.googleMapsUri,
      websiteUri: place.websiteUri,
      photoUrl: photoUrl, // 네이버 이미지 OR Fallback
      photoReference: null,
      location: place.location,
      types: place.types
    };

    // [6] DB에 캐시 저장
    const newKeywords = [placeName, placeData.place_name, place.formattedAddress].filter(Boolean).join('|');

    await supabase.from('places_cache').upsert([{
      place_id: placeData.place_id,
      place_name: placeData.place_name,
      search_keywords: newKeywords,
      rating: placeData.rating,
      rating_count: placeData.ratingCount,
      google_maps_uri: placeData.googleMapsUri,
      website_uri: placeData.websiteUri,
      photo_url: placeData.photoUrl,
      photo_reference: null,
      location: placeData.location,
      types: placeData.types
    }], { onConflict: 'place_id' }).select();

    addToCache(placeName, placeData);

    return placeData;
  } catch (error) {
    console.error(`⚠️ 검색 실패: ${placeName}`, error.message);
    return {
      place_name: placeName,
      photoUrl: getFallbackImage()
    };
  }
}

// 경로 계산 (3단계 시도: 대중교통 -> 운전 -> 도보)
async function calculateRoute(originId, destId) {
  if (!originId || !destId) return null;
  const modes = ['transit', 'driving', 'walking'];

  for (const mode of modes) {
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=place_id:${originId}&destination=place_id:${destId}&mode=${mode}&language=ko&key=${GOOGLE_MAPS_API_KEY}`;
      const response = await axios.get(url);
      if (response.data.status === 'OK' && response.data.routes.length > 0) {
        const leg = response.data.routes[0].legs[0];
        return {
          duration: leg.duration.text,
          distance: leg.distance.text,
          mode: mode === 'transit' ? '대중교통' : (mode === 'driving' ? '택시/차량' : '도보')
        };
      }
    } catch (error) { continue; }
  }
  return null;
}

// 🔧 날씨 API 인메모리 캐시 (429 에러 방지)
const weatherCache = new Map();
const WEATHER_CACHE_TTL = 60 * 60 * 1000; // 1시간

// 날씨 정보 조회 (Open-Meteo) - 개선된 버전 (Network Fix + Name Cleaning + Cache)
async function fetchDailyWeather(destination, startDate, endDate) {
  // 🔧 캐시 확인
  const cacheKey = `${destination}_${startDate}_${endDate}`;
  if (weatherCache.has(cacheKey)) {
    const cached = weatherCache.get(cacheKey);
    if (Date.now() - cached.timestamp < WEATHER_CACHE_TTL) {
      console.log(`☁️ Weather Cache Hit: ${destination}`);
      return cached.data;
    }
  }
  // 도시 이름 정제 함수
  const cleanCityName = (rawName) => {
    // 1. 국가명 제거
    let name = rawName.replace(/일본|대한민국|한국|중국|미국|프랑스|이탈리아|스페인|영국|독일/g, '').trim();

    // 2. 콤마가 있으면 첫 번째 부분만 사용 (예: "New York, 뉴욕" -> "New York")
    if (name.includes(',')) {
      name = name.split(',')[0].trim();
    }

    // 3. 한글/영어 혼합 시 영어 이름 우선 추출 (예: "뉴욕 New York" -> "New York")
    const englishMatch = name.match(/[A-Za-z\s]+/);
    if (englishMatch && englishMatch[0].trim().length > 2) {
      name = englishMatch[0].trim();
    }

    // 4. 한국 행정구역 접미사 제거
    return name.replace(/[시군구도부현]$/, '');
  };

  // 주요 도시 영문명 매핑 (Geocoding 정확도 향상)
  const cityNameMap = {
    // 일본
    '교토': 'Kyoto', '오사카': 'Osaka', '도쿄': 'Tokyo', '후쿠오카': 'Fukuoka',
    '삿포로': 'Sapporo', '나고야': 'Nagoya', '요코하마': 'Yokohama', '오키나와': 'Okinawa',
    // 한국
    '서울': 'Seoul', '부산': 'Busan', '제주': 'Jeju', '인천': 'Incheon', '대구': 'Daegu',
    // 미국 (주요 도시 - City 붙여서 정확도 향상)
    '뉴욕': 'New York City', 'New York': 'New York City',
    '로스앤젤레스': 'Los Angeles', '라스베이거스': 'Las Vegas',
    '샌프란시스코': 'San Francisco', '시카고': 'Chicago', '마이애미': 'Miami',
    '보스턴': 'Boston', '시애틀': 'Seattle', '워싱턴': 'Washington DC',
    // 유럽
    '파리': 'Paris', '런던': 'London', '로마': 'Rome', '바르셀로나': 'Barcelona',
    '암스테르담': 'Amsterdam', '프라하': 'Prague', '비엔나': 'Vienna',
    // 아시아
    '방콕': 'Bangkok', '홍콩': 'Hong Kong', '싱가포르': 'Singapore',
    '다낭': 'Da Nang', '호이안': 'Hoi An', '나트랑': 'Nha Trang', '푸꾸옥': 'Phu Quoc',
    '타이베이': 'Taipei', '가오슝': 'Kaohsiung',
    // 중동/오세아니아
    '두바이': 'Dubai', '시드니': 'Sydney', '멜버른': 'Melbourne'
  };

  try {
    let cleanedName = cleanCityName(destination);

    // cityNameMap에서 매칭되면 변환
    if (cityNameMap[cleanedName]) {
      cleanedName = cityNameMap[cleanedName];
    }

    console.log(`🌤️ Weather Fetch Started: ${destination} -> ${cleanedName} (${startDate} ~ ${endDate})`);

    const axiosConfig = {
      timeout: 5000, // 5초 타임아웃
      family: 4      // IPv4 강제 (Node 17+ AggregateError 방지)
    };

    // 1. Geocoding (count=5로 늘려서 더 정확한 결과 선택)
    let geoRes = await axios.get(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanedName)}&count=5&language=en&format=json`,
      axiosConfig
    );

    // 결과에서 인구가 가장 많은 도시 선택 (대도시 우선)
    if (geoRes.data.results && geoRes.data.results.length > 0) {
      const sortedResults = geoRes.data.results.sort((a, b) => (b.population || 0) - (a.population || 0));
      geoRes.data.results = [sortedResults[0]];
    }

    // 검색 실패 시, 한글로 재시도
    if (!geoRes.data.results || geoRes.data.results.length === 0) {
      console.log(`⚠️ Geocoding failed with (${cleanedName}), trying Korean...`);

      geoRes = await axios.get(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=5&language=ko&format=json`,
        axiosConfig
      );

      if (geoRes.data.results && geoRes.data.results.length > 0) {
        const sortedResults = geoRes.data.results.sort((a, b) => (b.population || 0) - (a.population || 0));
        geoRes.data.results = [sortedResults[0]];
      }
    }

    if (!geoRes.data.results || geoRes.data.results.length === 0) {
      console.error(`❌ Geocoding failed for: ${destination} (cleaned: ${cleanedName})`);
      return null;
    }

    const { latitude, longitude, name: geoName } = geoRes.data.results[0];
    console.log(`✅ Geocoding success: ${geoName} (${latitude}, ${longitude})`);

    // 2. Weather Forecast
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${startDate}&end_date=${endDate}`;
    console.log(`🌤️ Requesting Weather: ${weatherUrl}`);

    const weatherRes = await axios.get(weatherUrl, axiosConfig);

    if (!weatherRes.data.daily) {
      console.error(`❌ Weather data is empty for ${geoName}`);
      return null;
    }

    const daily = weatherRes.data.daily;
    const weatherMap = {};

    daily.time.forEach((date, index) => {
      weatherMap[date] = {
        code: daily.weather_code[index],
        max: daily.temperature_2m_max[index],
        min: daily.temperature_2m_min[index]
      };
    });

    console.log(`✅ Weather data fetched successfully for ${geoName}:`, Object.keys(weatherMap).length, 'days');

    // 🔧 캐시에 저장
    weatherCache.set(cacheKey, { data: weatherMap, timestamp: Date.now() });

    return weatherMap;
  } catch (error) {
    console.error("❌ Weather Fetch Error:", error.message);

    // 🔧 429 에러 시 WeatherAPI.com으로 fallback
    if (error.response?.status === 429) {
      console.log("🔄 Trying WeatherAPI.com fallback...");
      const fallbackResult = await fetchWeatherApiFallback(destination, startDate, endDate);
      if (fallbackResult) {
        weatherCache.set(cacheKey, { data: fallbackResult, timestamp: Date.now() });
        return fallbackResult;
      }
    }

    console.error("📍 Destination:", destination);
    if (error.response) {
      console.error("🔴 API Response Error:", error.response.status, error.response.data);
    }
    return null;
  }
}

// 🔧 WeatherAPI.com Fallback 함수
async function fetchWeatherApiFallback(destination, startDate, endDate) {
  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) {
    console.log("⚠️ WEATHER_API_KEY not configured, skipping fallback");
    return null;
  }

  try {
    // 🔧 한글 도시명 영어 변환 매핑
    const cityNameMap = {
      '서울': 'Seoul', '부산': 'Busan', '제주': 'Jeju', '인천': 'Incheon',
      '대구': 'Daegu', '광주': 'Gwangju', '대전': 'Daejeon', '울산': 'Ulsan',
      '도쿄': 'Tokyo', '오사카': 'Osaka', '교토': 'Kyoto', '후쿠오카': 'Fukuoka',
      '삿포로': 'Sapporo', '나고야': 'Nagoya', '오키나와': 'Okinawa',
      '뉴욕': 'New York', '로스앤젤레스': 'Los Angeles', '샌프란시스코': 'San Francisco',
      '파리': 'Paris', '런던': 'London', '로마': 'Rome', '바르셀로나': 'Barcelona',
      '방콕': 'Bangkok', '싱가포르': 'Singapore', '홍콩': 'Hong Kong',
      '다낭': 'Da Nang', '호이안': 'Hoi An', '타이베이': 'Taipei'
    };

    // 도시 이름 정제
    let cityName = destination.split(',')[0].trim();

    // 한글 도시명에서 영어로 변환
    for (const [korean, english] of Object.entries(cityNameMap)) {
      if (cityName.includes(korean)) {
        cityName = english;
        break;
      }
    }

    // 영어 이름 추출 (fallback)
    if (!/^[A-Za-z\s]+$/.test(cityName)) {
      const englishMatch = destination.match(/[A-Za-z\s]+/);
      if (englishMatch && englishMatch[0].trim().length > 2) {
        cityName = englishMatch[0].trim();
      }
    }

    console.log(`🌦️ WeatherAPI.com Request: ${cityName}`);

    // WeatherAPI.com은 예보 일수 기반 (최대 14일)
    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = Math.min(14, Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1);

    const response = await axios.get('https://api.weatherapi.com/v1/forecast.json', {
      params: {
        key: apiKey,
        q: cityName,
        days: days,
        lang: 'ko'
      },
      timeout: 5000
    });

    if (!response.data.forecast?.forecastday) {
      console.error("❌ WeatherAPI.com: No forecast data");
      return null;
    }

    const weatherMap = {};
    response.data.forecast.forecastday.forEach(day => {
      // WeatherAPI.com 코드를 Open-Meteo 코드로 변환 (간단 매핑)
      const conditionCode = day.day.condition.code;
      let weatherCode = 0; // 기본: 맑음

      if (conditionCode === 1000) weatherCode = 0; // Sunny/Clear
      else if ([1003, 1006, 1009].includes(conditionCode)) weatherCode = 2; // Cloudy
      else if ([1030, 1135, 1147].includes(conditionCode)) weatherCode = 45; // Fog
      else if ([1063, 1150, 1153, 1180, 1183, 1186, 1189, 1192, 1195, 1240, 1243, 1246].includes(conditionCode)) weatherCode = 61; // Rain
      else if ([1066, 1114, 1117, 1210, 1213, 1216, 1219, 1222, 1225, 1255, 1258].includes(conditionCode)) weatherCode = 71; // Snow
      else if ([1087, 1273, 1276, 1279, 1282].includes(conditionCode)) weatherCode = 95; // Thunderstorm

      weatherMap[day.date] = {
        code: weatherCode,
        max: Math.round(day.day.maxtemp_c),
        min: Math.round(day.day.mintemp_c)
      };
    });

    console.log(`✅ WeatherAPI.com: Got ${Object.keys(weatherMap).length} days of forecast`);
    return weatherMap;

  } catch (err) {
    console.error("❌ WeatherAPI.com Error:", err.message);
    return null;
  }
}

// --- [API 1] 여행 일정 생성 (Generate) ---
app.post('/api/generate-trip', async (req, res) => {
  console.log("Generate Trip Request Received");
  try {
    const { destination, startDate, endDate, arrivalTime, departureTime, otherRequirements, user_id, budget, travelers } = req.body;

    if (!user_id) return res.status(401).json({ error: "로그인이 필요합니다." });

    // 시간 유효성 검사 (3시간 미만 차단)
    const startDateTime = new Date(`${startDate}T${arrivalTime}`);
    const endDateTime = new Date(`${endDate}T${departureTime}`);
    if ((endDateTime - startDateTime) / (1000 * 60 * 60) < 3) {
      return res.status(400).json({ error: "체류 시간이 너무 짧습니다. (최소 3시간)" });
    }

    // 유저 제한 확인
    let { data: userLimit } = await supabase.from('user_limits').select('*').eq('user_id', user_id).single();
    if (!userLimit) {
      const { data: newLimit } = await supabase.from('user_limits').insert([{ user_id, tier: 'free', usage_count: 0 }]).select().single();
      userLimit = newLimit;
    }

    // 월별 초기화
    const today = new Date();
    const lastReset = new Date(userLimit.last_reset_date);
    if (today.getMonth() !== lastReset.getMonth() || today.getFullYear() !== lastReset.getFullYear()) {
      const { data: resetData } = await supabase.from('user_limits').update({ usage_count: 0, last_reset_date: new Date() }).eq('user_id', user_id).select().single();
      userLimit = resetData || { ...userLimit, usage_count: 0 };
    }

    // [Server-Side Limit Check]
    const limit = TIER_LIMITS[userLimit.tier] || 3;

    if (userLimit.tier !== 'admin' && userLimit.usage_count >= limit) {
      return res.status(403).json({
        error: "월간 생성 한도를 초과했습니다.",
        baseLimit: limit
      });
    }

    const totalDays = calculateDays(startDate, endDate);

    // 시간 제약 프롬프트
    let timeConstraint = "";
    if (totalDays === 1) {
      timeConstraint = `**[🚨 당일치기 필수]** 일정은 **${arrivalTime} 시작**, **${departureTime} 종료**. 범위 밖 일정 생성 금지.`;
    } else {
      timeConstraint = `**[시간 규칙]** Day 1: ${arrivalTime} 이후 시작. Day ${totalDays}: ${departureTime} 이전 종료. 나머지: 09:00~22:00 꽉 채움.`;
    }

    const prompt = `
      여행지: ${destination}
      기간: ${startDate} ~ ${endDate} (총 ${totalDays}일)
      인원: ${travelers || "1"}명
      예산: ${budget || "제한 없음"}
      ${timeConstraint}
      ✨ 사용자 요청: "${otherRequirements || "없음"}" (최우선 반영)

      [규칙]
      1. **[절대 원칙] 지역 고정:** 모든 장소는 반드시 **${destination}** 지역 내에 실제 위치해야 합니다. 이름만 같고 다른 지역에 있는 체인점이나, 엉뚱한 도시의 명소를 절대 포함하지 마세요. (예: 부산 여행에 '서울 남산타워' 추천 금지)
      2. **장소:** 구체적 상호명 필수 (예: '맛집' X -> '명동교자' O).
      3. **중복:** 같은 장소 반복 금지.
      4. **데이터:** photoUrl 등 상세 정보 제외.
      5. **[중요] 장소 유형 일관성:**
         - "식사" 타입은 반드시 음식점, 카페, 베이커리 등 식음료 전문점만 추천하세요.
         - 왁싱샵, 미용실, 네일샵, 마사지샵, 스파 등 뷰티/미용 업종은 "관광" 또는 "휴식" 타입으로만 분류하세요. 절대 "식사"로 분류하지 마세요.
         - 장소명에 "뷰티", "왁싱", "네일", "미용", "스파", "마사지" 등이 포함된 경우 식사 장소로 추천하면 안 됩니다.
         - activity_description은 반드시 place_name과 일치해야 합니다. (예: 왁싱샵인데 "카페에서 아침 식사" 설명 금지)

      [출력 JSON]
      { 
        "trip_title": "제목", 
        "cover_image_query": "Short English artistic image search query for this trip (e.g., 'Kyoto zen garden watercolor')",
        "itinerary": [ { "day": 1, "date": "YYYY-MM-DD", "activities": [ { "time": "HH:MM", "place_name": "장소명", "type": "관광/식사/숙소", "activity_description": "설명", "is_booking_required": true/false } ] } ] 
      }
    `;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const itineraryJson = cleanAndParseJSON(result.response.text());

    // [Weather Injection]
    const weatherMap = await fetchDailyWeather(destination, startDate, endDate);
    if (weatherMap) {
      itineraryJson.itinerary.forEach(day => {
        if (weatherMap[day.date]) {
          day.weather_info = weatherMap[day.date];
        }
      });
    }

    // [Optimization] Global Cache used instead of Request-Scoped
    // const placeDetailsCache = new Map(); // Removed local cache

    // 병렬 처리 & 데이터 보정
    const seenPlaces = new Set(); // ✨ [Fix] Move seenPlaces OUT of the loop to track duplicates across ALL days

    // ⚡ [Optimization] 병렬 처리로 전환 - 속도 대폭 개선
    for (const dayPlan of itineraryJson.itinerary) {
      const uniqueActivities = [];

      // 중복 제거 로직
      dayPlan.activities.forEach(act => {
        if (act.place_name.includes("이동") || act.place_name.includes("숙소")) {
          uniqueActivities.push(act);
        } else {
          if (!seenPlaces.has(act.place_name)) {
            seenPlaces.add(act.place_name);
            uniqueActivities.push(act);
          }
        }
      });

      // 🔧 [Fix] 뷰티/미용 업종이 "식사"로 분류된 경우 타입 수정
      const beautyKeywords = ['왁싱', '뷰티', '네일', '미용', '스파', '마사지', '피부', '에스테틱', '헤어'];
      uniqueActivities.forEach(act => {
        if (act.type === '식사') {
          const placeLower = act.place_name.toLowerCase();
          const descLower = (act.activity_description || '').toLowerCase();
          if (beautyKeywords.some(keyword => placeLower.includes(keyword) || descLower.includes(keyword))) {
            console.log(`⚠️ Correcting misclassified beauty place: ${act.place_name} (식사 -> 관광)`);
            act.type = '관광';
            // 설명도 장소와 맞지 않으면 수정
            if (descLower.includes('카페') || descLower.includes('식사') || descLower.includes('베이커리') || descLower.includes('빵')) {
              act.activity_description = `${act.place_name}에서 휴식 및 뷰티 체험을 즐깁니다.`;
            }
          }
        }
      });

      dayPlan.activities = uniqueActivities;

      // ⚡ 병렬 처리로 장소 상세 정보 조회
      const detailsPromises = dayPlan.activities.map(async (activity, i) => {
        // 이동은 패스
        if (activity.place_name.includes("이동") && !activity.place_name.includes("숙소")) {
          return { index: i, data: activity };
        }

        // [Cache Check]
        let details;
        if (placeDetailsCache.has(activity.place_name)) {
          details = await placeDetailsCache.get(activity.place_name);
        } else {
          const detailsPromise = fetchPlaceDetails(activity.place_name, destination);
          addToCache(activity.place_name, detailsPromise);
          details = await detailsPromise;
        }

        if (!details) details = { place_name: activity.place_name };

        let finalBookingUrl = null;
        const isPark = details.types && (details.types.includes('park') || details.types.includes('natural_feature'));

        if (!isPark && activity.is_booking_required) {
          if (details.websiteUri) finalBookingUrl = details.websiteUri;
          else if (details.googleMapsUri) finalBookingUrl = details.googleMapsUri;
          else finalBookingUrl = `https://www.google.com/search?q=${destination}+${activity.place_name}+예약`;
        }

        return {
          index: i,
          data: {
            ...activity,
            ...details,
            booking_url: finalBookingUrl,
            place_name: details.place_name || activity.place_name
          }
        };
      });

      // 모든 장소 정보 병렬 조회 완료 대기
      const results = await Promise.all(detailsPromises);
      results.forEach(({ index, data }) => {
        dayPlan.activities[index] = data;
      });

      // ⚡ [Optimization] 경로 계산은 On-Demand로 이동 (초기 로딩 3-5초 단축)
      // 사용자가 이동수단 버튼 클릭 시 /api/calculate-route API 호출
      // const routePromises = [];
      // for (let i = 1; i < dayPlan.activities.length; i++) {
      //   const prev = dayPlan.activities[i - 1];
      //   const curr = dayPlan.activities[i];
      //   if (prev.place_id && curr.place_id) {
      //     routePromises.push(
      //       calculateRoute(prev.place_id, curr.place_id).then(routeInfo => {
      //         if (routeInfo) curr.travel_info = routeInfo;
      //       })
      //     );
      //   }
      // }
      // await Promise.all(routePromises);
    }

    // ✨ [Optimization] Cover Photo Logic
    // Remove forced text cover generation. Leave it null/empty.
    // Frontend will handle it via 'getTripCoverImage' -> '/api/place-image'
    // This ensures real photos are used instead of "Text Covers".
    // const koreanRegion = await getKoreanRegionName(destination);
    // const coverImageUrl = `${SERVER_BASE_URL}/api/text-cover?text=${encodeURIComponent(koreanRegion)}`;
    // console.log(`🎨 Generated Text Cover: ${coverImageUrl} (from ${destination})`);

    const coverImageUrl = null; // Use NULL to trigger frontend fallback logic
    itineraryJson.cover_image = coverImageUrl;

    const { data, error } = await supabase.from('trip_plans').insert([{
      destination, duration: `${startDate} ~ ${endDate}`,
      style: "맞춤 여행", companions: "제한 없음",
      itinerary_data: itineraryJson,
      user_id
    }]).select();

    if (error) throw error;

    // Update usage count
    await supabase.from('user_limits').update({
      usage_count: userLimit.usage_count + 1
    }).eq('user_id', user_id);

    res.status(200).json({ success: true, data: data[0] });

  } catch (error) {
    console.error("Generate Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- [API 2] 일정 수정 (Modify - DB 저장 포함) ---
app.post('/api/modify-trip', async (req, res) => {
  try {
    const { trip_id, currentItinerary, userRequest, destination, user_id } = req.body;

    if (!user_id) return res.status(401).json({ error: "권한이 없습니다." });

    const simplifiedItinerary = {
      trip_title: currentItinerary.trip_title,
      itinerary: currentItinerary.itinerary.map(day => ({
        day: day.day,
        date: day.date,
        activities: day.activities.map(act => ({
          time: act.time,
          place_name: act.place_name,
          type: act.type,
          activity_description: act.activity_description,
          is_booking_required: act.is_booking_required
        }))
      }))
    };

    // 캐싱 (재사용)
    const existingPlacesMap = new Map();
    currentItinerary.itinerary.forEach(day => {
      day.activities.forEach(act => {
        if (act.place_name && act.photoUrl) {
          existingPlacesMap.set(act.place_name, act);
        }
      });
    });

    const prompt = `
      여행 전문가로서 일정을 수정해주세요.
      [여행지]: **${destination}** (변경 금지)
      [기존]: ${JSON.stringify(simplifiedItinerary)}
      ✨ [수정 요청]: "${userRequest}"
      
      [규칙]
      1. **[절대 원칙] 지역 고정:** 추천하는 장소는 반드시 **${destination}** 내에 있어야 합니다. 다른 지역의 장소를 추천하면 절대 안 됩니다.
      2. 시간: 저녁까지 꽉 채움.
      3. 중복 금지, 구체적 상호명.
      4. **[중요] 장소 변경 시:** 사용자가 특정 활동(예: 점심, 저녁)을 다른 종류(예: 라멘, 초밥)로 바꿔달라고 하면, **반드시 'place_name'을 새로운 가게 이름으로 변경해야 합니다.** 기존 장소 이름을 그대로 두고 설명만 바꾸면 절대 안 됩니다.
      - 예시: "점심을 라멘으로 바꿔줘" -> 기존 '명동교자'를 '이치란 라멘'으로 변경 (설명만 바꾸지 말 것!)
      5. **[일관성 필수]** 'place_name'과 'activity_description'은 반드시 일치해야 합니다.
      - 잘못된 예: place_name="스타벅스", activity_description="CGV에서 영화 관람" (X) -> 설명이 영화관이면 이름도 'CGV'여야 함.
      - 수정 요청에 따라 장소의 성격이 바뀌면(예: 식당 -> 실내 관광지), 반드시 이름도 그에 맞는 곳으로 변경하세요.
      
      [출력] JSON Only.
    `;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const modifiedJson = cleanAndParseJSON(result.response.text());

    const seenPlaces = new Set(); // ✨ [Fix] Move seenPlaces OUT of the loop for modify-trip too

    // ✨ [Optimization] 순차 처리 (Sequential Processing) for modify-trip
    // 네이버 API 429 에러 방지를 위해 Promise.all 대신 for...of 루프 사용
    for (const dayPlan of modifiedJson.itinerary) {
      const uniqueActivities = [];
      dayPlan.activities.forEach(act => {
        if (act.place_name.includes("이동") || act.place_name.includes("숙소")) {
          uniqueActivities.push(act);
        } else {
          if (!seenPlaces.has(act.place_name)) {
            seenPlaces.add(act.place_name);
            uniqueActivities.push(act);
          }
        }
      });
      dayPlan.activities = uniqueActivities;

      const enrichedActivities = [];
      for (const activity of dayPlan.activities) {
        if (activity.place_name.includes("이동") && !activity.place_name.includes("숙소")) {
          // 이동은 null로 처리하지 않고 건너뜀 (enrichedActivities에 추가 안함)
          continue;
        }

        // 💡 [Rate Limit 방지] 요청 사이에 0.2초 딜레이
        await delay(200);

        let details;
        if (existingPlacesMap.has(activity.place_name)) {
          const cached = existingPlacesMap.get(activity.place_name);
          details = { ...cached, ...activity };
        } else if (placeDetailsCache.has(activity.place_name)) {
          details = await placeDetailsCache.get(activity.place_name);
        } else {
          const detailsPromise = fetchPlaceDetails(activity.place_name, destination);
          addToCache(activity.place_name, detailsPromise);
          details = await detailsPromise;
        }

        if (!details) details = { place_name: activity.place_name };

        let finalBookingUrl = null;
        const isPark = details.types && (details.types.includes('park') || details.types.includes('natural_feature'));
        if (!isPark && activity.is_booking_required) {
          if (details.websiteUri) finalBookingUrl = details.websiteUri;
          else if (details.googleMapsUri) finalBookingUrl = details.googleMapsUri;
          else finalBookingUrl = `https://www.google.com/search?q=${destination}+${activity.place_name}+예약`;
        }
        activity.booking_url = finalBookingUrl;

        enrichedActivities.push({ ...activity, ...details, place_name: details.place_name || activity.place_name });
      }

      dayPlan.activities = enrichedActivities;

      for (let i = 1; i < dayPlan.activities.length; i++) {
        const prev = dayPlan.activities[i - 1];
        const curr = dayPlan.activities[i];
        if (prev.place_id && curr.place_id) {
          const routeInfo = await calculateRoute(prev.place_id, curr.place_id);
          if (routeInfo) curr.travel_info = routeInfo;
        }
      }
    }

    // DB 업데이트
    if (trip_id) {
      await supabase.from('trip_plans').update({ itinerary_data: modifiedJson }).eq('id', trip_id).eq('user_id', user_id);
    }

    res.status(200).json({ success: true, data: modifiedJson });

  } catch (error) {
    console.error("Modify Error:", error);
    res.status(500).json({ success: false, error: "수정 중 오류가 발생했습니다." });
  }
});

// --- [API 3.5] 장소 이미지 프록시 (New) ---
app.get('/api/place-image', async (req, res) => {
  const { query } = req.query;
  // ✨ [Fix] Prevent browser caching of redirects (especially fallbacks) so retries happen
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (!query) return res.redirect(FALLBACK_IMAGE_URL);

  try {
    // 1. 캐시 확인 (간단한 인메모리 캐시 활용)
    // 참고: 실제 프로덕션에서는 Redis 등을 사용하거나, fetchPlaceDetails 내부 캐시를 활용해야 함.
    // 여기서는 fetchNaverImage를 직접 호출하되, 추후 최적화 가능.

    // 2. 네이버 이미지 검색
    const imageUrl = await fetchNaverImage(query);

    if (imageUrl) {
      return res.redirect(imageUrl);
    }

    // 3. [Fallback] Google Places Photo (REMOVED)
    // if (googleRes) ... 

    // 4. 실패 시 기본 이미지
    return res.redirect(FALLBACK_IMAGE_URL);

  } catch (error) {
    console.error("Image Proxy Error:", error);
    return res.redirect(FALLBACK_IMAGE_URL);
  }
});



// --- [API 3] 자동완성 (New API + 도시 필터링) ---
app.get('/api/places/autocomplete', async (req, res) => {
  const { query } = req.query;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (!query) return res.status(200).json({ predictions: [] });

  try {
    // [Refinement] Limit granularity globally to Country, Level 1 (Do/State), Level 2 (Si/County), and Locality (City).
    // We MUST include 'locality' because major cities like "Las Vegas", "Paris", "London" are localities.
    // We exclude 'sublocality' and 'neighborhood' to avoid small districts (Dong/Eup/Myeon).
    const primaryTypes = ["locality", "administrative_area_level_1", "administrative_area_level_2", "country"];

    const response = await axios.post(
      `https://places.googleapis.com/v1/places:autocomplete`,
      {
        input: query,
        languageCode: "ko",
        includedPrimaryTypes: primaryTypes
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY
        }
      }
    );

    const suggestions = response.data.suggestions || [];
    let predictions = suggestions.map(item => ({
      description: item.placePrediction.text.text,
      place_id: item.placePrediction.placeId,
      secondary_text: item.placePrediction.structuredFormat?.secondaryText?.text || "",
      main_text: item.placePrediction.structuredFormat?.mainText?.text || item.placePrediction.text.text
    }));

    // [Fix] 정렬 로직 제거 (Google API 순서 신뢰) 및 필터링 완화
    // 기존 로직이 '부산'보다 '부산광역시'를 뒤로 보내는 등 부자연스러운 결과 초래
    // predictions.sort((a, b) => ... ); 

    // [Fix] Prioritize Korean results if query contains Korean
    const isKoreanQuery = /[가-힣]/.test(query);
    if (isKoreanQuery) {
      // 한국어로 검색 시 한국 지역만 필터링 (베트남, 인도 등 제외)
      predictions = predictions.filter(p =>
        p.description.includes("대한민국") ||
        p.description.includes("South Korea") ||
        p.description.includes("Korea")
      );
    }

    res.status(200).json({ predictions: predictions });

  } catch (error) {
    console.error("Autocomplete Error:", error.response?.data || error.message);
    res.status(200).json({ predictions: [] });
  }
});

// --- [API 4] 회원 탈퇴 ---
app.delete('/api/auth/delete', async (req, res) => {
  const { user_id, email } = req.body;
  if (!user_id) return res.status(400).json({ error: "User ID Required" });

  try {
    if (email) {
      await supabase.from('deleted_users').insert([{ email: email }]);
    }

    // 여행 일정은 삭제
    await supabase.from('trip_plans').delete().eq('user_id', user_id);
    await supabase.from('user_limits').delete().eq('user_id', user_id);

    // 건의사항/커뮤니티 글은 삭제하지 않고 "탈퇴한 사용자"로 표시
    await supabase.from('suggestions')
      .update({ user_id: null, email: '탈퇴한 사용자' })
      .eq('user_id', user_id);

    await supabase.from('community')
      .update({ user_id: null, nickname: '탈퇴한 사용자', email: '탈퇴한 사용자' })
      .eq('user_id', user_id);

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user_id);
    if (deleteError) throw deleteError;

    res.status(200).json({ success: true, message: "회원 탈퇴 완료" });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({ error: "탈퇴 처리 중 오류" });
  }
});

// --- [API 5] 건의사항 게시판 ---
app.get('/api/board', async (req, res) => {
  try {
    const { data, error } = await supabase.from('suggestions').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/board', async (req, res) => {
  const { user_id, email, content } = req.body;
  if (!content) return res.status(400).json({ error: "내용 부족" });

  try {
    const { data, error } = await supabase.from('suggestions').insert([{
      user_id: user_id || null,
      email: email || '익명',
      content
    }]).select();
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API] 탈퇴 이메일 재가입 가능 여부 확인 ---
app.post('/api/auth/check-deleted', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "이메일 필요" });

  try {
    const { data: deletedUser } = await supabase
      .from('deleted_users')
      .select('*')
      .eq('email', email)
      .order('deleted_at', { ascending: false })
      .limit(1)
      .single();

    if (deletedUser) {
      const deletedAt = new Date(deletedUser.deleted_at);
      const now = new Date();
      const daysSinceDelete = Math.floor((now - deletedAt) / (1000 * 60 * 60 * 24));
      const remainingDays = 30 - daysSinceDelete;

      if (remainingDays > 0) {
        return res.status(200).json({
          blocked: true,
          remainingDays: remainingDays,
          message: `탈퇴 후 30일이 지나지 않았습니다. ${remainingDays}일 후에 재가입이 가능합니다.`
        });
      }
    }

    res.status(200).json({ blocked: false });
  } catch (error) {
    // 데이터가 없는 경우 (차단 아님)
    res.status(200).json({ blocked: false });
  }
});



app.get('/api/public/trip/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('trip_plans')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Public trip fetch error:', error);
      return res.status(404).json({ success: false, error: '일정을 찾을 수 없습니다.' });
    }

    if (!data) {
      return res.status(404).json({ success: false, error: '일정을 찾을 수 없습니다.' });
    }

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Public trip error:', error);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// --- [API 7] 내 여행 목록 조회 ---
app.get('/api/my-trips', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: "User ID Required" });

  try {
    const { data, error } = await supabase
      .from('trip_plans')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 8] 여행 일정 삭제 ---
app.delete('/api/trip/:id', async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  if (!user_id) return res.status(400).json({ error: "User ID Required" });

  try {
    const { error } = await supabase
      .from('trip_plans')
      .delete()
      .eq('id', id)
      .eq('user_id', user_id);

    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 9] 커뮤니티 게시판 ---
app.get('/api/community', async (req, res) => {
  try {
    const { sort, period, user_id } = req.query;

    // 기간 필터 계산
    let dateFilter = null;
    if (period === 'day') {
      dateFilter = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    } else if (period === 'week') {
      dateFilter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (period === 'month') {
      dateFilter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    }

    // 게시글 조회
    let query = supabase.from('community').select('*');

    if (dateFilter) {
      query = query.gte('created_at', dateFilter);
    }

    query = query.order('created_at', { ascending: false });

    const { data: posts, error } = await query;
    if (error) throw error;

    // 각 게시글에 좋아요 수 추가
    const { data: allLikes } = await supabase
      .from('community_likes')
      .select('post_id, user_id');

    // 게시글별 사용자 정보 동적 조회 (닉네임, 프로필 사진)
    const postsWithUserInfo = await Promise.all(posts.map(async (post) => {
      const postLikes = allLikes?.filter(like => like.post_id == post.id) || [];

      let displayNickname = post.nickname;
      let avatarUrl = null;

      // 익명이 아니고 user_id가 있는 경우 최신 사용자 정보 조회
      if (!post.is_anonymous && post.user_id) {
        try {
          const { data: userData } = await supabaseAdmin.auth.admin.getUserById(post.user_id);
          if (userData?.user?.user_metadata) {
            const meta = userData.user.user_metadata;
            displayNickname = meta.nickname || post.nickname;
            avatarUrl = meta.custom_avatar_url || meta.avatar_url || null;
          }
        } catch (userErr) {
          // 사용자 정보 조회 실패 시 기존 닉네임 사용
          console.error(`Failed to fetch user info for ${post.user_id}:`, userErr.message);
        }
      }

      return {
        ...post,
        nickname: displayNickname,
        avatar_url: avatarUrl,
        likes_count: postLikes.length,
        user_liked: user_id ? postLikes.some(like => like.user_id === user_id) : false
      };
    }));

    // 인기순 정렬
    if (sort === 'popular') {
      postsWithUserInfo.sort((a, b) => b.likes_count - a.likes_count);
    }

    res.status(200).json({ success: true, data: postsWithUserInfo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/community', async (req, res) => {
  const { user_id, email, nickname, content, is_anonymous } = req.body;
  if (!content) return res.status(400).json({ error: "내용이 필요합니다" });

  try {
    const { data, error } = await supabase.from('community').insert([{
      user_id: user_id || null,
      email: email || '익명',
      nickname: nickname || '익명',
      content,
      is_anonymous: is_anonymous || false
    }]).select();
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/community/:id', async (req, res) => {
  const { id } = req.params;
  const { user_id, email } = req.body;

  try {
    const { data: post } = await supabase
      .from('community')
      .select('*')
      .eq('id', id)
      .single();

    if (!post) return res.status(404).json({ error: "게시글을 찾을 수 없습니다" });

    const isOwner = user_id && post.user_id === user_id;
    const isAdmin = email === ADMIN_EMAIL;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "삭제 권한이 없습니다" });
    }

    const { error } = await supabase.from('community').delete().eq('id', id);
    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 9.1] 좋아요 토글 ---
app.post('/api/community/:id/like', async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  if (!user_id) return res.status(401).json({ error: "로그인이 필요합니다" });

  try {
    // 기존 좋아요 확인
    const { data: existing } = await supabase
      .from('community_likes')
      .select('*')
      .eq('post_id', id)
      .eq('user_id', user_id)
      .single();

    if (existing) {
      // 좋아요 취소
      await supabase.from('community_likes').delete().eq('id', existing.id);
      res.status(200).json({ success: true, liked: false });
    } else {
      // 좋아요 추가
      await supabase.from('community_likes').insert([{ post_id: id, user_id }]);
      res.status(200).json({ success: true, liked: true });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 9.2] 게시글 좋아요 수 및 상태 조회 ---
app.get('/api/community/:id/likes', async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const { data: likes, count } = await supabase
      .from('community_likes')
      .select('*', { count: 'exact' })
      .eq('post_id', id);

    let userLiked = false;
    if (user_id) {
      userLiked = likes?.some(like => like.user_id === user_id) || false;
    }

    res.status(200).json({ success: true, count: count || 0, userLiked });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 9.3] 댓글 목록 조회 ---
app.get('/api/community/:id/comments', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: comments, error } = await supabase
      .from('community_comments')
      .select('*')
      .eq('post_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // 댓글별 사용자 정보 동적 조회 (닉네임, 프로필 사진)
    const commentsWithUserInfo = await Promise.all(comments.map(async (comment) => {
      let displayNickname = comment.nickname;
      let avatarUrl = null;

      // 익명이 아니고 user_id가 있는 경우 최신 사용자 정보 조회
      if (!comment.is_anonymous && comment.user_id) {
        try {
          const { data: userData } = await supabaseAdmin.auth.admin.getUserById(comment.user_id);
          if (userData?.user?.user_metadata) {
            const meta = userData.user.user_metadata;
            displayNickname = meta.nickname || comment.nickname;
            avatarUrl = meta.custom_avatar_url || meta.avatar_url || null;
          }
        } catch (userErr) {
          console.error(`Failed to fetch user info for ${comment.user_id}:`, userErr.message);
        }
      }

      return {
        ...comment,
        nickname: displayNickname,
        avatar_url: avatarUrl
      };
    }));

    res.status(200).json({ success: true, data: commentsWithUserInfo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 9.4] 댓글 작성 ---
app.post('/api/community/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { user_id, nickname, content, is_anonymous } = req.body;

  if (!content) return res.status(400).json({ error: "내용이 필요합니다" });

  try {
    const { data, error } = await supabase.from('community_comments').insert([{
      post_id: id,
      user_id: user_id || null,
      nickname: is_anonymous ? '익명' : (nickname || '익명'),
      content,
      is_anonymous: is_anonymous || false
    }]).select();

    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 9.5] 댓글 삭제 ---
app.delete('/api/community/comments/:id', async (req, res) => {
  const { id } = req.params;
  const { user_id, email } = req.body;

  try {
    const { data: comment } = await supabase
      .from('community_comments')
      .select('*')
      .eq('id', id)
      .single();

    if (!comment) return res.status(404).json({ error: "댓글을 찾을 수 없습니다" });

    const isOwner = user_id && comment.user_id === user_id;
    const isAdmin = email === ADMIN_EMAIL;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "삭제 권한이 없습니다" });
    }

    const { error } = await supabase.from('community_comments').delete().eq('id', id);
    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 9.6] 여행 일정 프리뷰 (카드용) ---
app.get('/api/trip-preview/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('trip_plans')
      .select('id, destination, duration, itinerary_data')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: "일정을 찾을 수 없습니다" });
    }

    // 첫 번째 활동의 이미지를 커버로 사용
    let coverImage = null;
    if (data.itinerary_data?.itinerary?.[0]?.activities?.[0]?.photoUrl) {
      coverImage = data.itinerary_data.itinerary[0].activities[0].photoUrl;
    }

    res.status(200).json({
      success: true,
      data: {
        id: data.id,
        title: data.itinerary_data?.trip_title || data.destination,
        destination: data.destination,
        duration: data.duration,
        coverImage: coverImage || FALLBACK_IMAGE_URL
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 9.7] 닉네임 조회/저장 ---
app.get('/api/user/profile', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: "User ID 필요" });

  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', user_id)
      .single();

    res.status(200).json({ success: true, data: data || null });
  } catch (error) {
    res.status(200).json({ success: true, data: null });
  }
});

app.put('/api/user/profile', async (req, res) => {
  const { user_id, nickname: rawNickname } = req.body;
  if (!user_id) return res.status(400).json({ error: "User ID 필요" });

  // 공백 제거 및 검증
  const nickname = rawNickname?.trim();
  if (!nickname || nickname.length < 2 || nickname.length > 12) {
    return res.status(400).json({ error: "닉네임은 2~12자로 입력해주세요" });
  }

  try {
    // 1. 중복 체크 (본인 제외) - maybeSingle 사용으로 에러 방지
    const { data: existing } = await supabase
      .from('user_profiles')
      .select('user_id')
      .eq('nickname', nickname)
      .neq('user_id', user_id)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ error: "이미 사용 중인 닉네임입니다" });
    }

    // 2. user_profiles 테이블 upsert
    const { data, error } = await supabase
      .from('user_profiles')
      .upsert({
        user_id,
        nickname,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
      .select();

    if (error) throw error;

    // 3. 기존 게시글 닉네임도 업데이트 (익명이 아닌 글만)
    const { error: communityError } = await supabase
      .from('community')
      .update({ nickname })
      .eq('user_id', user_id)
      .eq('is_anonymous', false);

    if (communityError) console.error("Community update error:", communityError);

    // 4. 기존 댓글 닉네임도 업데이트 (익명이 아닌 댓글만)
    const { error: commentsError } = await supabase
      .from('community_comments')
      .update({ nickname })
      .eq('user_id', user_id)
      .eq('is_anonymous', false);

    if (commentsError) console.error("Comments update error:", commentsError);

    console.log(`✅ Nickname updated for user ${user_id}: ${nickname}`);
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- [API 10] 관리자 페이지 ---
app.get('/api/admin/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_limits')
      .select('user_id, tier, usage_count')
      .order('usage_count', { ascending: false });

    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/user/tier', async (req, res) => {
  const { target_user_id, new_tier } = req.body;

  if (!target_user_id || !new_tier) {
    return res.status(400).json({ error: "필수 정보가 누락되었습니다" });
  }

  try {
    const { error } = await supabase
      .from('user_limits')
      .update({ tier: new_tier })
      .eq('user_id', target_user_id);

    if (error) throw error;
    res.status(200).json({ success: true, message: "등급이 변경되었습니다" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API 10.5] 표지 사진 일괄 업데이트 (Admin) ---
app.post('/api/admin/update-covers', async (req, res) => {
  const { secret_key } = req.body;
  // 간단한 보안 키 확인 (실제 운영 시에는 더 강력한 보안 필요)
  if (secret_key !== process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && secret_key !== "admin_secret") {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    console.log("🔄 Starting Batch Cover Image Update...");

    // 1. 모든 여행 일정 가져오기
    const { data: trips, error } = await supabase
      .from('trip_plans')
      .select('id, destination, itinerary_data')
      .order('created_at', { ascending: false });

    if (error) throw error;

    let updatedCount = 0;
    const results = [];

    // 2. 순차적으로 업데이트 (Rate Limit 방지)
    for (const trip of trips) {
      const { id, destination, itinerary_data } = trip;

      // 이미 좋은 이미지가 있는지 확인 (선택 사항: 강제 업데이트 플래그 추가 가능)
      // 여기서는 무조건 업데이트하거나, 특정 조건(예: unsplash)일 때만 업데이트하도록 설정 가능
      // 현재는 "기존 이미지 갱신" 요청이므로 모든 항목에 대해 시도합니다.

      // Text-Based Cover Image Update -> SWITCHED TO "Null" for Dynamic Fetch
      // Old: const koreanRegion = await getKoreanRegionName(destination);
      // Old: const newImage = `${SERVER_BASE_URL}/api/text-cover?text=${encodeURIComponent(koreanRegion)}`;

      const newImage = null; // Let frontend fetch dynamically via getTripCoverImage
      console.log(`🖼️ Updating Trip ${id} (${destination}) -> NULL (Dynamic Fetch Enabled)`);

      // JSON 데이터 업데이트
      itinerary_data.cover_image = newImage;

      // DB 저장
      await supabase
        .from('trip_plans')
        .update({ itinerary_data: itinerary_data })
        .eq('id', id);

      updatedCount++;
      results.push({ id, destination, status: "updated", image: newImage });

      // 딜레이 (0.1초 - 텍스트 생성은 빠르므로 짧게)
      await delay(100);
    }

    console.log(`✅ Batch Update Completed. Updated: ${updatedCount}/${trips.length}`);
    res.status(200).json({ success: true, updatedCount, total: trips.length, results });

  } catch (error) {
    console.error("Batch Update Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- [API 11] 건의사항 삭제 ---
app.delete('/api/board/:id', async (req, res) => {
  const { id } = req.params;
  const { user_id, email } = req.body;

  try {
    const { data: suggestion } = await supabase
      .from('suggestions')
      .select('*')
      .eq('id', id)
      .single();

    if (!suggestion) return res.status(404).json({ error: "건의사항을 찾을 수 없습니다" });

    const isOwner = user_id && suggestion.user_id === user_id;
    const isAdmin = email === ADMIN_EMAIL;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "삭제 권한이 없습니다" });
    }

    const { error } = await supabase.from('suggestions').delete().eq('id', id);
    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [API] 경로 계산 On-Demand ---
app.post('/api/calculate-route', async (req, res) => {
  try {
    const { origin_place_id, destination_place_id, mode } = req.body;

    if (!origin_place_id || !destination_place_id) {
      return res.status(400).json({ error: "출발지와 도착지 place_id가 필요합니다" });
    }

    // mode: walking, transit, driving (기본값: transit)
    const travelMode = mode || 'transit';

    const modeMap = {
      'walking': 'walking',
      'transit': 'transit',
      'driving': 'driving'
    };

    const googleMode = modeMap[travelMode] || 'transit';

    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: {
          origin: `place_id:${origin_place_id}`,
          destination: `place_id:${destination_place_id}`,
          mode: googleMode,
          language: 'ko',
          key: GOOGLE_MAPS_API_KEY
        }
      });

      if (response.data.routes && response.data.routes.length > 0) {
        const leg = response.data.routes[0].legs[0];
        return res.json({
          success: true,
          data: {
            duration: leg.duration.text,
            distance: leg.distance.text,
            mode: travelMode === 'transit' ? '대중교통' : (travelMode === 'driving' ? '자동차' : '도보')
          }
        });
      }
    } catch (error) {
      console.error(`Route calculation error:`, error.message);
    }

    res.json({ success: false, error: "경로를 찾을 수 없습니다" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- [Scheduler] Image Health Check ---
const { startImageScheduler } = require('./jobs/image_cron');
startImageScheduler();

app.listen(PORT, () => {
  console.log(`🚀 TripGen Server running on port ${PORT}`);
});
