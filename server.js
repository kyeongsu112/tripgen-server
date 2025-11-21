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
// 모델은 최신 상황에 맞춰서 변경 가능 (예: gemini-pro 또는 gemini-1.5-flash 등)
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
      place_id: place.id,
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
        duration: leg.duration.text,
        distance: leg.distance.text,
      };
    }
    return null;
  } catch (error) {
    console.error("❌ Route Error:", error.message);
    return null;
  }
}

// --- [API 1] 여행 일정 생성 (사용량 제한 + 시간 제약 추가) ---
app.post('/api/generate-trip', async (req, res) => {
  try {
    // ✨ arrivalTime, departureTime 추가
    const { destination, startDate, endDate, style, companions, arrivalTime, departureTime, user_id } = req.body;

    if (!user_id) return res.status(401).json({ error: "로그인이 필요합니다." });

    // 1. 사용량 제한 확인
    let { data: userLimit } = await supabase
      .from('user_limits')
      .select('*')
      .eq('user_id', user_id)
      .single();

    if (!userLimit) {
      const { data: newLimit } = await supabase
        .from('user_limits')
        .insert([{ user_id, tier: 'free', usage_count: 0 }])
        .select()
        .single();
      userLimit = newLimit;
    }

    // 월별 초기화
    const today = new Date();
    const lastReset = new Date(userLimit.last_reset_date);
    if (today.getMonth() !== lastReset.getMonth() || today.getFullYear() !== lastReset.getFullYear()) {
      userLimit.usage_count = 0;
      await supabase.from('user_limits').update({ usage_count: 0, last_reset_date: new Date() }).eq('user_id', user_id);
    }

    // 한도 초과 차단 (관리자는 예외)
    const limit = TIER_LIMITS[userLimit.tier] || 3;
    if (userLimit.tier !== 'admin' && userLimit.usage_count >= limit) {
      return res.status(403).json({ 
        error: `이번 달 생성 한도(${limit}회)를 모두 사용하셨습니다.` 
      });
    }

    // 2. AI 생성 프롬프트 (✨ 시간 제약 및 예약 링크 반영)
    const totalDays = calculateDays(startDate, endDate);
    const prompt = `
      여행지: ${destination}
      기간: ${startDate} 부터 ${endDate} 까지 (총 ${totalDays}일)
      스타일: ${style}
      동행: ${companions}
      
      **[시간 제약 조건 - 필수]**
      1. 첫째 날(${startDate}): 비행기 도착 시간이 **${arrivalTime || "정보 없음"}** 입니다. 이 시간 이후부터 일정을 시작하세요.
      2. 마지막 날(${endDate}): 비행기 출발 시간이 **${departureTime || "정보 없음"}** 입니다. 공항 이동 시간을 고려하여 이 시간 3시간 전에는 일정을 종료하세요.
      
      **[요청사항]**
      1. '숙소', '이동'만 있는 활동은 제외하고 **실제 방문할 장소** 위주로 구성하세요.
      2. 장소 이름은 구글 지도 검색용 공식 명칭을 사용하세요.
      3. **booking_url 필드 추가:**
         - 입장권이나 예약이 필요한 장소(박물관, 테마파크, 고급 식당 등)는 공식 홈페이지나 예매 링크를 찾아서 넣어주세요.
         - 링크를 찾기 어렵다면 구글 검색 URL 포맷("https://www.google.com/search?q=${destination}+장소명+예약")을 넣어주세요.
         - 공원이나 거리처럼 예약이 필요 없는 곳은 null로 설정하세요.

      **[출력 형식 - JSON Only]**
      반드시 아래 JSON 포맷으로만 출력하세요. 마크다운 기호(json)나 설명은 쓰지 마세요.
      { 
        "trip_title": "제목", 
        "itinerary": [ 
          { 
            "day": 1, 
            "date": "YYYY-MM-DD", 
            "activities": [ 
              { 
                "time": "HH:MM", 
                "place_name": "장소명", 
                "type": "관광/식사/카페", 
                "activity_description": "활동 설명",
                "booking_url": "URL 또는 null"
              } 
            ] 
          } 
        ] 
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    const itineraryJson = JSON.parse(text);

    // 3. 데이터 보정 (API 호출)
    for (const dayPlan of itineraryJson.itinerary) {
      const enrichedActivities = [];
      for (const activity of dayPlan.activities) {
        if (activity.type === "숙소" || activity.place_name.includes("이동")) {
           enrichedActivities.push(activity);
           continue;
        }
        const details = await fetchPlaceDetails(activity.place_name);
        enrichedActivities.push({ ...activity, ...details });
      }

      // 경로 계산 (이동 시간)
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

    // 4. DB 저장
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

    // 5. 사용 횟수 증가
    await supabase
      .from('user_limits')
      .update({ usage_count: userLimit.usage_count + 1 })
      .eq('user_id', user_id);

    res.status(200).json({ success: true, data: data[0] });

  } catch (error) {
    console.error("🔥 Server Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- [API 2] 내 여행 목록 조회 ---
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

// --- [API 3] 여행 일정 삭제 ---
app.delete('/api/trip/:id', async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body; // DELETE 요청도 body에 user_id 필요 (또는 헤더)
  if (!user_id) return res.status(401).json({ error: "권한이 없습니다." });

  const { error } = await supabase
    .from('trip_plans')
    .delete()
    .eq('id', id)
    .eq('user_id', user_id);

  if (error) return res.status(500).json({ error: error.message });
  
  res.status(200).json({ success: true, message: "삭제되었습니다." });
});

// --- [API 4] 관리자용: 모든 유저 조회 ---
app.get('/api/admin/users', async (req, res) => {
  const { data, error } = await supabase
    .from('user_limits')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ success: true, data });
});

// --- [API 5] 관리자용: 유저 등급 수정 ---
app.put('/api/admin/user/tier', async (req, res) => {
  const { target_user_id, new_tier } = req.body;
  if (!target_user_id || !new_tier) return res.status(400).json({ error: "정보 부족" });

  const { data, error } = await supabase
    .from('user_limits')
    .update({ tier: new_tier })
    .eq('user_id', target_user_id)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ success: true, message: "등급 변경 완료", data });
});

// --- [API 6] 공유용: 공개 조회 ---
app.get('/api/public/trip/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('trip_plans')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return res.status(404).json({ error: "일정을 찾을 수 없습니다." });
  res.status(200).json({ success: true, data });
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`🚀 TripGen Server running on port ${PORT}`);
});