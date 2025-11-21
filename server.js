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

// 모델 설정 (최신 모델 사용)
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

// --- [Helper] 장소 상세 정보 조회 (Places API 강화됨) ---
async function fetchPlaceDetails(placeName) {
  // "숙소 체크인" 등은 API 검색 제외
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
          // ✨ [핵심 변경] places.types를 추가로 가져와서 장소 유형을 파악함
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
      place_name: placeName, // 구글이 인식한 정식 명칭
      rating: place.rating || "정보 없음",
      ratingCount: place.userRatingCount || 0,
      googleMapsUri: place.googleMapsUri || "#",
      websiteUri: place.websiteUri || null,
      location: place.location,
      photoUrl: photoUrl,
      types: place.types || [] // 장소 유형 (park, restaurant 등)
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

// --- [API 1] 여행 일정 생성 (프롬프트 및 로직 대폭 수정) ---
app.post('/api/generate-trip', async (req, res) => {
  try {
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

    const limit = TIER_LIMITS[userLimit.tier] || 3;
    if (userLimit.tier !== 'admin' && userLimit.usage_count >= limit) {
      return res.status(403).json({ error: `이번 달 생성 한도(${limit}회)를 모두 사용하셨습니다.` });
    }

    // totalDays 계산 (프롬프트보다 먼저)
    const totalDays = calculateDays(startDate, endDate);

    // 2. 프롬프트 생성 (구체적 상호명 요구 & 예약 링크 로직 강화)
    const prompt = `
      여행지: ${destination}
      기간: ${startDate} 부터 ${endDate} 까지 (총 ${totalDays}일)
      스타일: ${style}
      동행: ${companions}
      
      **[필수 시간 제약]**
      1. Day 1: 도착 시간 **${arrivalTime || "오전 10:00"}** 이후부터 일정을 시작하세요.
      2. Day ${totalDays}: 출발 시간 **${departureTime || "오후 6:00"}** 3시간 전에는 공항으로 출발하도록 일정을 종료하세요.

      **[일정 구성 요구사항 - 매우 중요]**
      1. **구체적인 상호명 필수:** - "성수동 맛집", "근처 카페", "점심 식사" 같은 추상적인 표현을 **절대 금지**합니다.
         - 반드시 **직전 관광지 근처의 실존하는 구체적인 식당 이름**(예: 소문난성수감자탕, 난포)을 지정하세요.
      2. **숙소:** Day 1 오후에 "숙소 체크인", 매일 마지막에 "숙소 복귀"를 포함하세요.
      3. **동선 최적화:** 식사는 반드시 직전 방문지에서 도보 15분 이내의 거리로 배정하세요.

      **[예약 링크(booking_url) 생성 규칙]**
      - **링크 생성 대상 (O):** 테마파크, 유료 박물관, 공연, 고급 레스토랑(예약 필수), 체험 클래스.
      - **링크 생성 금지 (X):** **공원(Park), 산책로, 숲, 거리**, 야시장, 쇼핑몰, 푸드코트, 일반 카페.
      - **금지 대상은 반드시 booking_url을 null로 설정하세요.**
      - 생성 시 포맷: "https://www.google.com/search?q=${destination}+[장소명]+예약"

      **[출력 형식 - JSON Only]**
      반드시 아래 JSON 포맷으로만 출력하세요.
      { 
        "trip_title": "여행 제목", 
        "itinerary": [ 
          { 
            "day": 1, 
            "date": "YYYY-MM-DD", 
            "activities": [ 
              { 
                "time": "HH:MM", 
                "place_name": "구체적인 장소명 (식당인 경우 반드시 상호명)", 
                "type": "관광/식사/숙소", 
                "activity_description": "설명",
                "booking_url": "https://... 또는 null"
              } 
            ] 
          } 
        ] 
      }
    `;
    
    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    const itineraryJson = JSON.parse(text);

    // 3. 데이터 보정 (숙소 허용, Places API 연동, 예약 링크 필터링)
    for (const dayPlan of itineraryJson.itinerary) {
      const enrichedActivities = [];
      for (const activity of dayPlan.activities) {
        
        // 이동 제외
        if (activity.place_name.includes("이동") && !activity.place_name.includes("숙소")) {
             continue; 
        }

        // 장소 정보 가져오기
        const details = await fetchPlaceDetails(activity.place_name);
        
        // ✨ [핵심 로직 1] 예약 링크 필터링 (API 검증)
        // 구글이 식별한 장소 유형(types)에 공원, 자연 등이 포함되면 예약 링크 무조건 제거
        const nonBookingTypes = ['park', 'natural_feature', 'point_of_interest', 'establishment', 'locality', 'political', 'sublocality'];
        // point_of_interest는 너무 광범위하므로, tourist_attraction이나 museum이 없으면서 point_of_interest만 있는 경우 등을 체크해야 하지만,
        // 여기서는 'park'(공원)나 'natural_feature'(자연)가 포함되면 확실히 제거합니다.
        
        if (details.types && (details.types.includes('park') || details.types.includes('natural_feature'))) {
            activity.booking_url = null;
        } else {
             // ✨ [핵심 로직 2] 예약 링크 보완
             // 공원이 아닌데 AI가 링크를 안 줬고, 공식 홈페이지가 있다면 채워넣기
             if (!activity.booking_url && details.websiteUri) {
                activity.booking_url = details.websiteUri;
             }
        }

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
  const { user_id } = req.body; 
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