require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
// Render 배포 환경 호환 (기본값 8080)
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// --- [설정] 환경 변수 및 클라이언트 ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 모델 설정 (최신 안정화 버전)
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// --- [설정] 등급별 월간 이용 한도 ---
const TIER_LIMITS = {
  free: 3,        // 무료 회원: 월 3회
  pro: 30,        // 유료 회원: 월 30회
  admin: Infinity // 관리자: 무제한
};

// --- [Helper] 날짜 차이 계산 ---
function calculateDays(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffTime = Math.abs(endDate - startDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
}

// --- [Helper] 장소 상세 정보 조회 (Places API) ---
async function fetchPlaceDetails(placeName) {
  // 이동, 숙소 체크인 등은 API 검색 제외
  if (placeName.includes("체크인") || placeName.includes("숙소") || placeName.includes("복귀")) {
     return { place_name: placeName, type: "숙소" };
  }

  try {
    const response = await axios.post(
      `https://places.googleapis.com/v1/places:searchText`,
      { textQuery: placeName, languageCode: "ko" },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
          // ✨ websiteUri, googleMapsUri, types 필수 요청
          "X-Goog-FieldMask": "places.id,places.photos,places.rating,places.userRatingCount,places.googleMapsUri,places.location,places.websiteUri,places.types" 
        }
      }
    );
    
    const place = response.data.places && response.data.places[0];
    if (!place) return { place_name: placeName }; 

    let photoUrl = null;
    if (place.photos && place.photos.length > 0) {
      const photoReference = place.photos[0].name;
      photoUrl = `https://places.googleapis.com/v1/${photoReference}/media?key=${GOOGLE_MAPS_API_KEY}&maxHeightPx=400&maxWidthPx=400`;
    }

    return {
      place_id: place.id,
      place_name: placeName, // 구글 정식 명칭
      rating: place.rating || "정보 없음",
      ratingCount: place.userRatingCount || 0,
      googleMapsUri: place.googleMapsUri || "#",
      websiteUri: place.websiteUri || null, // 공식 홈페이지
      location: place.location,
      photoUrl: photoUrl,
      types: place.types || [] 
    };
  } catch (error) {
    console.error(`⚠️ [${placeName}] 검색 실패:`, error.message);
    return { place_name: placeName };
  }
}

// --- [Helper] 경로 계산 (Directions API) ---
async function calculateRoute(originId, destId) {
  if (!originId || !destId) return null;
  
  try {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=place_id:${originId}&destination=place_id:${destId}&mode=transit&language=ko&key=${GOOGLE_MAPS_API_KEY}`;
    const response = await axios.get(url);
    
    if (response.data.status === 'OK' && response.data.routes.length > 0) {
      const leg = response.data.routes[0].legs[0];
      return {
        duration: leg.duration.text,
        distance: leg.distance.text,
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

// --- [API 1] 여행 일정 생성 (스타일/동행 제거 -> 기타 요구사항 통합) ---
app.post('/api/generate-trip', async (req, res) => {
  try {
    // ✨ style, companions 파라미터 제거됨
    const { destination, startDate, endDate, arrivalTime, departureTime, otherRequirements, user_id } = req.body;

    if (!user_id) return res.status(401).json({ error: "로그인이 필요합니다." });

    // 1. 사용량 제한 확인
    let { data: userLimit } = await supabase.from('user_limits').select('*').eq('user_id', user_id).single();

    if (!userLimit) {
      const { data: newLimit } = await supabase.from('user_limits').insert([{ user_id, tier: 'free', usage_count: 0 }]).select().single();
      userLimit = newLimit;
    }

    const today = new Date();
    const lastReset = new Date(userLimit.last_reset_date);
    if (today.getMonth() !== lastReset.getMonth() || today.getFullYear() !== lastReset.getFullYear()) {
      userLimit.usage_count = 0;
      await supabase.from('user_limits').update({ usage_count: 0, last_reset_date: new Date() }).eq('user_id', user_id);
    }

    const limit = TIER_LIMITS[userLimit.tier] || 3;
    if (userLimit.tier !== 'admin' && userLimit.usage_count >= limit) {
      return res.status(403).json({ error: `이번 달 생성 한도(${limit}회)를 모두 사용하셨습니다.` });
    }

    const totalDays = calculateDays(startDate, endDate);

    // 2. 프롬프트 생성 (기타 요구사항 반영)
    const prompt = `
      여행지: ${destination}
      기간: ${startDate} 부터 ${endDate} 까지 (총 ${totalDays}일)
      
      **[필수 시간 제약]**
      1. Day 1: 도착 시간 **${arrivalTime || "오전 10:00"}** 이후부터 일정을 시작하세요.
      2. Day ${totalDays}: 출발 시간 **${departureTime || "오후 6:00"}** 3시간 전에는 공항으로 출발하도록 일정을 종료하세요.

      ✨ **[사용자 특별 요청사항 (최우선 반영)]**
      : "${otherRequirements || "특별한 요구사항 없음 (일반적인 추천 코스로 작성)"}"
      (위 요청사항을 반영하여 장소 선정, 식당 스타일, 동선을 구성하세요.)

      **[일정 구성 가이드]**
      1. **장소:** "맛집" 같은 추상적 표현 금지. 반드시 실존하는 **구체적인 상호명**을 기입하세요.
      2. **숙소:** Day 1 오후에 "숙소 체크인", 매일 마지막에 "숙소 복귀"를 포함하세요.
      3. **동선:** 식사는 직전 방문지 근처, 이동 효율을 고려하세요.

      **[is_booking_required 필드 판단 (URL 생성 금지)]**
      - **true:** 호텔, 테마파크, 유료 박물관, 공연, 예약 필수 고급 레스토랑.
      - **false:** 공원, 무료 관광지, 야시장, 푸드코트, 일반 카페, 예약 안 받는 식당.
      - 예약 필요 여부(true/false)만 판단하세요.

      **[출력 형식 - JSON Only]**
      반드시 아래 JSON 포맷으로만 출력하세요.
      { 
        "trip_title": "여행 제목 (예: 도쿄 3박 4일 힐링 여행)", 
        "itinerary": [ 
          { 
            "day": 1, 
            "date": "YYYY-MM-DD", 
            "activities": [ 
              { 
                "time": "HH:MM", 
                "place_name": "장소명", 
                "type": "관광/식사/숙소", 
                "activity_description": "설명",
                "is_booking_required": true 또는 false
              } 
            ] 
          } 
        ] 
      }
    `;
    
    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    const itineraryJson = JSON.parse(text);

    // 3. 데이터 보정 (스마트 링크 로직)
    for (const dayPlan of itineraryJson.itinerary) {
      const enrichedActivities = [];
      for (const activity of dayPlan.activities) {
        if (activity.place_name.includes("이동") && !activity.place_name.includes("숙소")) continue; 

        // 장소 정보 조회
        const details = await fetchPlaceDetails(activity.place_name);
        
        // ✨ 스마트 링크 결정 로직
        let finalBookingUrl = null;
        const isPark = details.types && (details.types.includes('park') || details.types.includes('natural_feature'));
        
        if (!isPark && activity.is_booking_required) {
          if (details.websiteUri) finalBookingUrl = details.websiteUri; // 1순위: 공식 홈피
          else if (details.googleMapsUri) finalBookingUrl = details.googleMapsUri; // 2순위: 구글 지도
          else finalBookingUrl = `https://www.google.com/search?q=${destination}+${activity.place_name}+예약`; // 3순위: 검색
        }
        activity.booking_url = finalBookingUrl;

        enrichedActivities.push({ ...activity, ...details });
      }

      // 경로 계산
      for (let i = 1; i < enrichedActivities.length; i++) {
        const prev = enrichedActivities[i - 1];
        const curr = enrichedActivities[i];
        if (prev.place_id && curr.place_id) {
          const routeInfo = await calculateRoute(prev.place_id, curr.place_id);
          if (routeInfo) curr.travel_info = routeInfo; 
        }
      }
      dayPlan.activities = enrichedActivities;
    }

    // 4. DB 저장 (Style, Companions 필드가 DB에 있다면 기본값으로 저장)
    const { data, error } = await supabase.from('trip_plans').insert([{ 
        destination, 
        duration: `${startDate} ~ ${endDate}`, 
        style: "맞춤 여행", // ✨ 기본값 처리
        companions: "제한 없음", // ✨ 기본값 처리
        itinerary_data: itineraryJson, 
        user_id 
    }]).select();

    if (error) throw error;
    await supabase.from('user_limits').update({ usage_count: userLimit.usage_count + 1 }).eq('user_id', user_id);

    res.status(200).json({ success: true, data: data[0] });

  } catch (error) {
    console.error("🔥 Server Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- [API 2] 일정 수정 (Modify) ---
app.post('/api/modify-trip', async (req, res) => {
  try {
    const { currentItinerary, userRequest, destination, user_id } = req.body;

    if (!user_id) return res.status(401).json({ error: "권한이 없습니다." });

    const prompt = `
      당신은 여행 전문가입니다. 아래 기존 여행 일정을 사용자의 요청에 맞춰 수정해주세요.
      
      [여행지]: ${destination}
      [기존 일정 JSON]: ${JSON.stringify(currentItinerary)}
      
      ✨ [사용자 수정 요청]: "${userRequest}"
      
      [지침]
      1. 사용자의 요청을 반영하여 일정(장소, 시간, 순서 등)을 변경하세요.
      2. 요청과 관련 없는 다른 일정은 최대한 유지하세요.
      3. JSON 구조는 기존과 완벽하게 동일해야 합니다.
      4. 변경된 장소에 대해서는 'is_booking_required'를 다시 판단하세요.
      5. 오직 JSON만 출력하세요.
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    const modifiedJson = JSON.parse(text);

    // 수정된 일정 재검증
    for (const dayPlan of modifiedJson.itinerary) {
      const enrichedActivities = [];
      for (const activity of dayPlan.activities) {
        // 기존 정보가 있고 수정되지 않았다면 API 호출 생략 (속도 최적화)
        if (activity.place_id && activity.photoUrl && !activity.is_booking_required) { 
           enrichedActivities.push(activity);
           continue; 
        }

        if (activity.place_name.includes("이동") && !activity.place_name.includes("숙소")) continue;
        
        const details = await fetchPlaceDetails(activity.place_name);
        
        let finalBookingUrl = null;
        const isPark = details.types && (details.types.includes('park') || details.types.includes('natural_feature'));
        
        if (!isPark && activity.is_booking_required) {
          if (details.websiteUri) finalBookingUrl = details.websiteUri;
          else if (details.googleMapsUri) finalBookingUrl = details.googleMapsUri;
          else finalBookingUrl = `https://www.google.com/search?q=${destination}+${activity.place_name}+예약`;
        }
        activity.booking_url = finalBookingUrl;

        enrichedActivities.push({ ...activity, ...details });
      }
      
      // 경로 재계산
      for (let i = 1; i < enrichedActivities.length; i++) {
        const prev = enrichedActivities[i - 1];
        const curr = enrichedActivities[i];
        if (prev.place_id && curr.place_id) {
          const routeInfo = await calculateRoute(prev.place_id, curr.place_id);
          if (routeInfo) curr.travel_info = routeInfo; 
        }
      }
      dayPlan.activities = enrichedActivities;
    }

    res.status(200).json({ success: true, data: modifiedJson });

  } catch (error) {
    console.error("Modify Error:", error);
    res.status(500).json({ success: false, error: "수정 중 오류가 발생했습니다." });
  }
});

// --- [API 3] 자동완성 (Autocomplete) ---
app.get('/api/places/autocomplete', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ predictions: [] });

  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json`,
      {
        params: {
          input: query,
          language: 'ko',
          key: GOOGLE_MAPS_API_KEY
        }
      }
    );
    
    if (response.data.status === 'OK') {
      res.status(200).json({ predictions: response.data.predictions });
    } else {
      res.status(200).json({ predictions: [] });
    }
  } catch (error) {
    console.error("Autocomplete Error:", error.message);
    res.status(500).json({ error: "자동완성 검색 실패" });
  }
});

// --- 기타 API ---
app.get('/api/my-trips', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: "로그인이 필요합니다." });
  const { data, error } = await supabase.from('trip_plans').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  res.status(200).json({ success: true, data });
});

app.delete('/api/trip/:id', async (req, res) => {
  const { id } = req.params; const { user_id } = req.body;
  const { error } = await supabase.from('trip_plans').delete().eq('id', id).eq('user_id', user_id);
  res.status(200).json({ success: true, message: "삭제되었습니다." });
});

app.get('/api/admin/users', async (req, res) => {
  const { data, error } = await supabase.from('user_limits').select('*').order('created_at', { ascending: false });
  res.status(200).json({ success: true, data });
});

app.put('/api/admin/user/tier', async (req, res) => {
  const { target_user_id, new_tier } = req.body;
  const { data, error } = await supabase.from('user_limits').update({ tier: new_tier }).eq('user_id', target_user_id).select();
  res.status(200).json({ success: true, message: "등급 변경 완료", data });
});

app.get('/api/public/trip/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('trip_plans').select('*').eq('id', id).single();
  res.status(200).json({ success: true, data });
});

app.listen(PORT, () => {
  console.log(`🚀 TripGen Server running on port ${PORT}`);
});