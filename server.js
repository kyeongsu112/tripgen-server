// tripgen-server/server.js (Final Version)
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
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// --- [설정] 등급별 월간 이용 한도 ---
const TIER_LIMITS = {
  free: 3,   // 무료 회원: 월 3회
  pro: 30    // 유료 회원: 월 30회
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
  try {
    const response = await axios.post(
      `https://places.googleapis.com/v1/places:searchText`,
      { textQuery: placeName, languageCode: "ko" },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "places.id,places.photos,places.rating,places.userRatingCount,places.googleMapsUri,places.location" 
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
      place_id: place.id, // 지도 경로 및 이동 계산용 ID
      place_name: placeName, 
      rating: place.rating || "정보 없음",
      ratingCount: place.userRatingCount || 0,
      googleMapsUri: place.googleMapsUri || "#",
      location: place.location,
      photoUrl: photoUrl
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
        duration: leg.duration.text, // 예: "15분"
        distance: leg.distance.text, // 예: "2.5km"
      };
    }
    return null;
  } catch (error) {
    console.error("❌ Route Error:", error.message);
    return null;
  }
}

// --- [API 1] 여행 일정 생성 (POST) ---
app.post('/api/generate-trip', async (req, res) => {
  try {
    const { destination, startDate, endDate, style, companions, user_id } = req.body;

    // 1. 로그인 체크
    if (!user_id) {
      return res.status(401).json({ error: "로그인이 필요합니다." });
    }

    // 2. [핵심] 사용량 제한 확인 로직
    // 2-1. DB에서 유저 제한 정보 조회
    let { data: userLimit, error: limitError } = await supabase
      .from('user_limits')
      .select('*')
      .eq('user_id', user_id)
      .single();

    // 정보가 없으면(첫 사용자) 새로 생성
    if (!userLimit) {
      const { data: newLimit } = await supabase
        .from('user_limits')
        .insert([{ user_id, tier: 'free', usage_count: 0 }])
        .select()
        .single();
      userLimit = newLimit;
    }

    // 2-2. 월별 초기화 체크 (마지막 사용일과 월이 다르면 리셋)
    const today = new Date();
    const lastReset = new Date(userLimit.last_reset_date);
    if (today.getMonth() !== lastReset.getMonth() || today.getFullYear() !== lastReset.getFullYear()) {
      userLimit.usage_count = 0;
      await supabase
        .from('user_limits')
        .update({ usage_count: 0, last_reset_date: new Date() })
        .eq('user_id', user_id);
    }

    // 2-3. 한도 초과 차단
    const limit = TIER_LIMITS[userLimit.tier] || 3;
    if (userLimit.usage_count >= limit) {
      return res.status(403).json({ 
        error: `이번 달 생성 한도(${limit}회)를 모두 사용하셨습니다. 다음 달에 다시 이용해주세요!` 
      });
    }

    // --- AI 생성 로직 시작 ---
    const totalDays = calculateDays(startDate, endDate);
    console.log(`📩 요청: ${destination} (${totalDays}일) - User: ${user_id} (${userLimit.usage_count}/${limit})`);

    const prompt = `
      여행지: ${destination}
      기간: ${startDate} 부터 ${endDate} 까지 (총 ${totalDays}일)
      스타일: ${style}
      동행: ${companions}
      
      위 조건으로 여행 일정을 계획하세요.
      [요청사항] 
      1. '숙소 체크인', '이동' 등 단순 항목은 제외하고 **실제 방문할 맛집이나 관광지** 위주로 구성.
      2. 장소 이름은 구글 지도에서 검색되기 쉬운 정확한 명칭 사용.
      3. 결과는 오직 **JSON 형식**으로만 출력.

      JSON 구조:
      {
        "trip_title": "여행 제목",
        "itinerary": [
          { 
            "day": 1, 
            "date": "${startDate}",
            "activities": [
              { "time": "10:00", "place_name": "장소명", "type": "관광/식사", "activity_description": "설명" }
            ] 
          }
        ]
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    const itineraryJson = JSON.parse(text);

    // --- 데이터 보정 (장소 검증 & 경로 계산) ---
    for (const dayPlan of itineraryJson.itinerary) {
      const enrichedActivities = [];
      // A. 장소 정보 확보
      for (const activity of dayPlan.activities) {
        if (activity.type === "숙소" || activity.place_name.includes("이동")) {
           enrichedActivities.push(activity);
           continue;
        }
        const details = await fetchPlaceDetails(activity.place_name);
        enrichedActivities.push({ ...activity, ...details });
      }

      // B. 이동 경로 계산 (순차 처리)
      for (let i = 1; i < enrichedActivities.length; i++) {
        const prev = enrichedActivities[i - 1];
        const curr = enrichedActivities[i];
        // 두 장소 모두 Place ID가 있어야 경로 계산 가능
        if (prev.place_id && curr.place_id) {
          const routeInfo = await calculateRoute(prev.place_id, curr.place_id);
          if (routeInfo) curr.travel_info = routeInfo; 
        }
      }
      dayPlan.activities = enrichedActivities;
    }

    // 3. DB 저장 (일정)
    const { data, error } = await supabase
      .from('trip_plans')
      .insert([{ 
        destination, 
        duration: `${startDate} ~ ${endDate}`, 
        style, 
        companions, 
        itinerary_data: itineraryJson, 
        user_id 
      }])
      .select();

    if (error) throw error;

    // 4. [중요] 사용 횟수 차감 (1 증가)
    await supabase
      .from('user_limits')
      .update({ usage_count: userLimit.usage_count + 1 })
      .eq('user_id', user_id);

    console.log("✅ 생성 완료 및 횟수 차감 성공!");
    res.status(200).json({ success: true, data: data[0] });

  } catch (error) {
    console.error("🔥 서버 에러:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- [API 2] 내 여행 목록 조회 (GET) ---
app.get('/api/my-trips', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: "로그인이 필요합니다." });

  const { data, error } = await supabase
    .from('trip_plans')
    .select('*')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ success: true, data });
});

// --- [API 3] 여행 일정 삭제 (DELETE) ---
app.delete('/api/trip/:id', async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body; // 본인 확인용

  if (!user_id) return res.status(401).json({ error: "권한이 없습니다." });

  // 내 아이디와 일치하는 일정만 삭제
  const { error } = await supabase
    .from('trip_plans')
    .delete()
    .eq('id', id)
    .eq('user_id', user_id);

  if (error) return res.status(500).json({ error: error.message });
  
  res.status(200).json({ success: true, message: "삭제되었습니다." });
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`🚀 TripGen Server running on port ${PORT}`);
});