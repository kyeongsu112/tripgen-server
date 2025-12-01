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

const TIER_LIMITS = { free: 3, pro: 30, admin: Infinity };
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

// 네이버 이미지 검색 (Naver Search API)
async function fetchNaverImage(query) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/image', {
      params: { query: query, display: 1, sort: 'sim', filter: 'medium' },
      headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
    });
    if (response.data.items && response.data.items.length > 0) {
      return response.data.items[0].link;
    }
  } catch (error) {
    console.error(`Naver Image Search Error for ${query}:`, error.message);
  }
  return null;
}

// 장소 상세 정보 조회 (Cache -> Naver Image -> Google API)
async function fetchPlaceDetails(placeName, cityContext = "") {
  if (placeName.includes("체크인") || placeName.includes("숙소") || placeName.includes("복귀")) {
    return { place_name: placeName, type: "숙소" };
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

    // [Self-Healing] 이미지가 없으면 네이버에서 다시 찾아 채워넣음
    if (!cachedPlace.photo_url) {
      // 💡 검색어 조합: "도시명 + 장소명"이 가장 정확함
      const searchQuery = cityContext ? `${cityContext} ${placeName}` : placeName;
      const naverImage = await fetchNaverImage(searchQuery);

      if (naverImage) {
        cachedPlace.photo_url = naverImage;
        // 비동기 업데이트 (사용자 응답 대기 안 함)
        supabase.from('places_cache')
          .update({ photo_url: naverImage })
          .eq('place_id', cachedPlace.place_id)
          .then(({ error }) => {
            if (!error) console.log("🔄 Updated cached photo URL (Naver) for:", placeName);
          });
      }
    }
    return cachedPlace;
  }

  // [3] Google Places API Call (텍스트 정보만! 사진 X)
  try {
    const response = await axios.post(
      `https://places.googleapis.com/v1/places:searchText`,
      { textQuery: `${placeName} ${cityContext}`, languageCode: "ko" },
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
    if (!place) return { place_name: placeName };

    console.log(`📍 API Search Result: ${place.displayName?.text}`);

    // [4] Naver Image Search (Primary)
    // 💡 구글 장소명이 더 정확하므로 구글이 준 이름(place.displayName.text)을 사용하여 검색
    const searchName = place.displayName?.text || placeName;
    const searchQuery = cityContext ? `${cityContext} ${searchName}` : searchName;

    let photoUrl = await fetchNaverImage(searchQuery);

    // 만약 네이버 이미지를 못 찾았다면? -> Fallback 이미지 사용 (구글 포토 호출 X)
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
      photoUrl: photoUrl, // 네이버 이미지
      photoReference: null,
      location: place.location,
      types: place.types
    };

    // [5] DB에 캐시 저장
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

    addToCache(placeName, placeData); // 메모리 캐시에도 저장

    return placeData;
  } catch (error) {
    console.error(`⚠️ 검색 실패: ${placeName}`, error.message);
    return { place_name: placeName };
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

// 날씨 정보 조회 (Open-Meteo) - 개선된 버전 (Network Fix + Name Cleaning)
async function fetchDailyWeather(destination, startDate, endDate) {
  // 도시 이름 정제 함수
  const cleanCityName = (rawName) => {
    let name = rawName.replace(/일본|대한민국|한국|중국|미국|프랑스|이탈리아|스페인|영국|독일/g, '').trim();
    // [Fix] 공백 분리 로직 제거 (뉴욕 주 -> 주 되는 문제 해결)
    // 필요한 경우에만 정제하도록 변경
    return name.replace(/[시군구도부현]$/, '');
  };

  try {
    const cleanedName = cleanCityName(destination);
    console.log(`🌤️ Weather Fetch Started: ${destination} -> ${cleanedName} (${startDate} ~ ${endDate})`);

    const axiosConfig = {
      timeout: 5000, // 5초 타임아웃
      family: 4      // IPv4 강제 (Node 17+ AggregateError 방지)
    };

    // 1. Geocoding (한글 시도)
    let geoRes = await axios.get(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanedName)}&count=1&language=ko&format=json`,
      axiosConfig
    );

    // 한글로 검색 실패 시, 영어로 재시도
    if (!geoRes.data.results || geoRes.data.results.length === 0) {
      console.log(`⚠️ Geocoding failed with Korean name (${cleanedName}), trying English...`);

      // 간단한 한영 변환 시도 (주요 도시만)
      const cityNameMap = {
        '교토': 'Kyoto', '오사카': 'Osaka', '도쿄': 'Tokyo', '후쿠오카': 'Fukuoka',
        '삿포로': 'Sapporo', '나고야': 'Nagoya', '요코하마': 'Yokohama', '오키나와': 'Okinawa',
        '서울': 'Seoul', '부산': 'Busan', '제주': 'Jeju',
        '파리': 'Paris', '런던': 'London', '뉴욕': 'New York', '로마': 'Rome',
        '바르셀로나': 'Barcelona', '방콕': 'Bangkok', '홍콩': 'Hong Kong',
        '싱가포르': 'Singapore', '두바이': 'Dubai', '시드니': 'Sydney',
        '다낭': 'Da Nang', '호이안': 'Hoi An', '나트랑': 'Nha Trang', '푸꾸옥': 'Phu Quoc',
        '타이베이': 'Taipei', '가오슝': 'Kaohsiung'
      };

      const englishName = cityNameMap[cleanedName] || cleanedName;
      console.log(`🔄 Retrying with: ${englishName}`);

      geoRes = await axios.get(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(englishName)}&count=1&language=en&format=json`,
        axiosConfig
      );
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
    return weatherMap;
  } catch (error) {
    console.error("❌ Weather Fetch Error:", error.message);
    if (error.code === 'ECONNABORTED') {
      console.error("⏰ Request timed out");
    }
    console.error("📍 Destination:", destination);
    if (error.response) {
      console.error("🔴 API Response Error:", error.response.status, error.response.data);
    } else {
      console.error("🔴 Error Stack:", error.stack);
      return null;
    }
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

    // [Server-Side Limit Check with Ad Credits]
    const limit = TIER_LIMITS[userLimit.tier] || 3;
    const adCredits = userLimit.ad_credits || 0;
    const totalAllowed = limit + adCredits;

    if (userLimit.tier !== 'admin' && userLimit.usage_count >= totalAllowed) {
      return res.status(403).json({
        error: "월간 생성 한도를 초과했습니다.",
        baseLimit: limit,
        adCredits: adCredits,
        canEarnMore: true
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

      [출력 JSON]
      { "trip_title": "제목", "itinerary": [ { "day": 1, "date": "YYYY-MM-DD", "activities": [ { "time": "HH:MM", "place_name": "장소명", "type": "관광/식사/숙소", "activity_description": "설명", "is_booking_required": true/false } ] } ] }
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

    // 2. 병렬 처리 대신 "순차 처리(Sequential)"로 변경하여 API 부하 분산
    // Promise.all 대신 for...of 루프 사용
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
      dayPlan.activities = uniqueActivities;

      // 액티비티 상세 정보 조회 (순차 처리 + 딜레이)
      for (let i = 0; i < dayPlan.activities.length; i++) {
        const activity = dayPlan.activities[i];

        // 이동/숙소는 패스하지만, 정보가 필요하면 로직 유지
        if (activity.place_name.includes("이동") && !activity.place_name.includes("숙소")) continue;

        // 💡 [Rate Limit 방지] 요청 사이에 0.2초 딜레이
        await delay(200);

        // [Cache Check]
        let details;
        if (placeDetailsCache.has(activity.place_name)) {
          details = await placeDetailsCache.get(activity.place_name);
        } else {
          const detailsPromise = fetchPlaceDetails(activity.place_name, destination);
          addToCache(activity.place_name, detailsPromise); // Use global cache helper
          details = await detailsPromise;
        }

        if (!details) details = { place_name: activity.place_name }; // ✨ 안전장치 추가

        let finalBookingUrl = null;
        const isPark = details.types && (details.types.includes('park') || details.types.includes('natural_feature'));

        if (!isPark && activity.is_booking_required) {
          if (details.websiteUri) finalBookingUrl = details.websiteUri;
          else if (details.googleMapsUri) finalBookingUrl = details.googleMapsUri;
          else finalBookingUrl = `https://www.google.com/search?q=${destination}+${activity.place_name}+예약`;
        }

        // 객체 업데이트
        dayPlan.activities[i] = {
          ...activity,
          ...details,
          booking_url: finalBookingUrl,
          place_name: details.place_name || activity.place_name
        };
      }

      // 경로 계산 (순차 처리)
      for (let i = 1; i < dayPlan.activities.length; i++) {
        const prev = dayPlan.activities[i - 1];
        const curr = dayPlan.activities[i];
        if (prev.place_id && curr.place_id) {
          const routeInfo = await calculateRoute(prev.place_id, curr.place_id);
          if (routeInfo) curr.travel_info = routeInfo;
        }
      }
    }

    // ✨ [New] 대표 이미지(Cover Image) 선정 로직
    // 전체 일정 중 'tourist_attraction' 타입이면서 사진이 있는 곳을 찾음
    let bestCoverImage = null;
    let fallbackImage = null;

    for (const day of itineraryJson.itinerary) {
      for (const act of day.activities) {
        if (act.photoUrl) {
          // 1순위: 관광지 사진
          if (act.types && act.types.includes('tourist_attraction')) {
            bestCoverImage = act.photoUrl;
            break; // 찾았으면 루프 종료
          }
          // 2순위: 아무 사진이나 (백업용)
          if (!fallbackImage) fallbackImage = act.photoUrl;
        }
      }
      if (bestCoverImage) break;
    }

    // 관광지 사진이 없으면 백업 사진 사용, 그것도 없으면 Unsplash/고정 이미지 사용은 프론트에서 처리
    itineraryJson.cover_image = bestCoverImage || fallbackImage || null;

    const { data, error } = await supabase.from('trip_plans').insert([{
      destination, duration: `${startDate} ~ ${endDate}`,
      style: "맞춤 여행", companions: "제한 없음",
      itinerary_data: itineraryJson, // cover_image가 포함된 JSON 저장
      user_id
    }]).select();

    if (error) throw error;

    // Update usage count and decrement ad_credits if using bonus credits
    const usedAdCredit = userLimit.usage_count >= limit && adCredits > 0;
    await supabase.from('user_limits').update({
      usage_count: userLimit.usage_count + 1,
      ...(usedAdCredit ? { ad_credits: adCredits - 1 } : {})
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

  if (!query) return res.redirect("https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?q=80&w=800&auto=format&fit=crop");

  try {
    // 1. 캐시 확인 (간단한 인메모리 캐시 활용)
    // 참고: 실제 프로덕션에서는 Redis 등을 사용하거나, fetchPlaceDetails 내부 캐시를 활용해야 함.
    // 여기서는 fetchNaverImage를 직접 호출하되, 추후 최적화 가능.

    // 2. 네이버 이미지 검색
    const imageUrl = await fetchNaverImage(query);

    if (imageUrl) {
      return res.redirect(imageUrl);
    }

    // 3. [Fallback] Google Places Photo
    try {
      console.log(`⚠️ Naver failed for ${query}, trying Google Places Fallback...`);
      const googleRes = await axios.post(
        `https://places.googleapis.com/v1/places:searchText`,
        { textQuery: query },
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
        const googlePhotoUrl = `${SERVER_BASE_URL}/api/proxy/google-photo/${place.photos[0].name}`;
        return res.redirect(googlePhotoUrl);
      }
    } catch (googleError) {
      console.error("Google Fallback Error:", googleError.message);
    }

    // 4. 실패 시 기본 이미지
    return res.redirect(FALLBACK_IMAGE_URL);

  } catch (error) {
    console.error("Image Proxy Error:", error);
    return res.redirect(FALLBACK_IMAGE_URL);
  }
});

// --- [API 3.6] Google Photo Proxy (Secure) ---
// [Fix] Use Regex route to avoid string parsing issues with special characters
app.get(/\/api\/proxy\/google-photo\/(.*)/, async (req, res) => {
  const photoName = req.params[0];
  res.redirect(FALLBACK_IMAGE_URL);
});

// --- [API 3] 자동완성 (New API + 도시 필터링) ---
app.get('/api/places/autocomplete', async (req, res) => {
  const { query } = req.query;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (!query) return res.status(200).json({ predictions: [] });

  try {
    const response = await axios.post(
      `https://places.googleapis.com/v1/places:autocomplete`,
      {
        input: query,
        languageCode: "ko",
        includedPrimaryTypes: ["locality", "administrative_area_level_1", "administrative_area_level_2", "country"]
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
      predictions.sort((a, b) => {
        const aIsKorea = a.description.includes("대한민국") || a.description.includes("South Korea");
        const bIsKorea = b.description.includes("대한민국") || b.description.includes("South Korea");
        if (aIsKorea && !bIsKorea) return -1;
        if (!aIsKorea && bIsKorea) return 1;
        return 0;
      });
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
    await supabase.from('trip_plans').delete().eq('user_id', user_id);
    await supabase.from('user_limits').delete().eq('user_id', user_id);
    await supabase.from('suggestions').delete().eq('user_id', user_id);
    await supabase.from('community').delete().eq('user_id', user_id);

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user_id);
    if (deleteError) throw deleteError;

    res.status(200).json({ success: true, message: "회원 탈퇴 완료" });
  } catch (error) {
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

// --- [API 6] 광고 리워드 적립 ---
app.post('/api/ad/redeem', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "User ID Required" });

  try {
    const today = new Date().toISOString().split('T')[0];
    let { data: userLimit } = await supabase.from('user_limits').select('*').eq('user_id', user_id).single();

    if (!userLimit) return res.status(404).json({ error: "User not found" });

    const lastAdDate = userLimit.last_ad_watch_date ? new Date(userLimit.last_ad_watch_date).toISOString().split('T')[0] : null;
    let dailyCount = userLimit.daily_ad_count || 0;

    if (lastAdDate !== today) {
      dailyCount = 0;
    }

    if (dailyCount >= 2) {
      return res.status(403).json({ error: "일일 광고 시청 한도 초과 (최대 2회)" });
    }

    await supabase.from('user_limits').update({
      ad_credits: (userLimit.ad_credits || 0) + 1,
      daily_ad_count: dailyCount + 1,
      last_ad_watch_date: new Date()
    }).eq('user_id', user_id);

    res.status(200).json({ success: true, credits: (userLimit.ad_credits || 0) + 1, dailyRemaining: 2 - dailyCount });
  } catch (error) {
    console.error("Redeem Ad Credit Error:", error);
    res.status(500).json({ error: "크레딧 획득 실패" });
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
    const { data, error } = await supabase
      .from('community')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json({ success: true, data });
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

// --- [API 10] 관리자 페이지 ---
app.get('/api/admin/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_limits')
      .select('user_id, tier, usage_count, ad_credits')
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

// --- [API 12] 광고 리워드 (Alias) ---
app.post('/api/redeem-ad-credit', async (req, res) => {
  // 기존 /api/ad/redeem 로직 재사용
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "User ID Required" });

  try {
    const today = new Date().toISOString().split('T')[0];
    let { data: userLimit } = await supabase.from('user_limits').select('*').eq('user_id', user_id).single();

    if (!userLimit) return res.status(404).json({ error: "User not found" });

    const lastAdDate = userLimit.last_ad_watch_date ? new Date(userLimit.last_ad_watch_date).toISOString().split('T')[0] : null;
    let dailyCount = userLimit.daily_ad_count || 0;

    if (lastAdDate !== today) {
      dailyCount = 0;
    }

    if (dailyCount >= 2) {
      return res.status(403).json({ error: "일일 광고 시청 한도 초과 (최대 2회)" });
    }

    await supabase.from('user_limits').update({
      ad_credits: (userLimit.ad_credits || 0) + 1,
      daily_ad_count: dailyCount + 1,
      last_ad_watch_date: new Date()
    }).eq('user_id', user_id);

    res.status(200).json({ success: true, credits: (userLimit.ad_credits || 0) + 1, dailyRemaining: 2 - dailyCount });
  } catch (error) {
    console.error("Redeem Ad Credit Error:", error);
    res.status(500).json({ error: "크레딧 획득 실패" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 TripGen Server running on port ${PORT}`);
});
