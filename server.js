// tripgen-server/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
// Render 배포 시 process.env.PORT 사용 (필수)
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// --- [설정] 환경 변수 및 클라이언트 초기화 ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
// Gemini 2.0 Flash 모델 사용 (속도/성능 최적화)
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// --- [Helper] 날짜 차이 계산 (몇 박 며칠인지) ---
function calculateDays(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffTime = Math.abs(endDate - startDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
}

// --- [Helper 1] 장소 상세 정보 가져오기 (Google Places API) ---
async function fetchPlaceDetails(placeName) {
  try {
    const response = await axios.post(
      `https://places.googleapis.com/v1/places:searchText`,
      { textQuery: placeName, languageCode: "ko" },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
          // 필요한 필드만 요청: ID(경로용), 사진, 평점, 링크, 좌표
          "X-Goog-FieldMask": "places.id,places.photos,places.rating,places.userRatingCount,places.googleMapsUri,places.location" 
        }
      }
    );
    
    const place = response.data.places && response.data.places[0];
    // 검색 결과가 없으면 이름만 반환 (에러 방지)
    if (!place) return { place_name: placeName }; 

    // 사진 URL 변환 (API는 ID만 주므로 URL로 만들어야 함)
    let photoUrl = null;
    if (place.photos && place.photos.length > 0) {
      const photoReference = place.photos[0].name;
      photoUrl = `https://places.googleapis.com/v1/${photoReference}/media?key=${GOOGLE_MAPS_API_KEY}&maxHeightPx=400&maxWidthPx=400`;
    }

    return {
      place_id: place.id, // [중요] 지도 경로 그릴 때 필수
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

// --- [Helper 2] 이동 경로 계산 (Google Directions API) ---
async function calculateRoute(originId, destId) {
  // 두 장소의 ID가 모두 있어야 계산 가능
  if (!originId || !destId) return null;
  
  try {
    // 대중교통(transit) 모드로 경로 조회
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
    
    // 1. 기간 계산
    const totalDays = calculateDays(startDate, endDate);
    console.log(`📩 요청: ${destination} (${totalDays}일) / User: ${user_id || 'Guest'}`);

    // 2. AI 프롬프트 작성
    const prompt = `
      여행지: ${destination}
      기간: ${startDate} 부터 ${endDate} 까지 (총 ${totalDays}일)
      스타일: ${style}
      동행: ${companions}
      
      위 조건으로 여행 일정을 계획하세요.
      
      [중요 요청사항]
      1. '호텔 체크인', '공항 도착' 같은 단순 이동은 최소화하고, **실제 방문할 맛집이나 관광지** 위주로 짜주세요.
      2. 장소 이름은 구글 지도에서 검색되기 쉬운 정확한 명칭을 사용하세요.
      3. 결과는 오직 **JSON 형식**으로만 주세요.

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

    // 3. AI 생성 요청
    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim(); // 마크다운 제거
    const itineraryJson = JSON.parse(text);

    console.log("🤖 AI 일정 생성 완료. 장소 검증 및 경로 계산 시작...");

    // 4. 데이터 보강 (장소 정보 + 이동 경로)
    for (const dayPlan of itineraryJson.itinerary) {
      
      // (A) 장소 상세 정보 가져오기 (병렬 처리 대신 순차 처리로 로직 단순화)
      const enrichedActivities = [];
      for (const activity of dayPlan.activities) {
        // '숙소'나 '이동'은 검색 제외 (API 비용 절약 및 오류 방지)
        if (activity.type === "숙소" || activity.place_name.includes("이동")) {
           enrichedActivities.push(activity);
           continue;
        }

        const details = await fetchPlaceDetails(activity.place_name);
        enrichedActivities.push({ ...activity, ...details });
      }

      // (B) 장소 간 이동 시간 계산
      for (let i = 1; i < enrichedActivities.length; i++) {
        const prev = enrichedActivities[i - 1];
        const curr = enrichedActivities[i];

        // 이전 장소와 현재 장소 모두 Place ID가 있어야 경로 계산 가능
        if (prev.place_id && curr.place_id) {
          const routeInfo = await calculateRoute(prev.place_id, curr.place_id);
          if (routeInfo) {
            // 현재 장소 데이터에 '여기까지 오는 정보' 추가
            curr.travel_info = routeInfo; 
          }
        }
      }

      dayPlan.activities = enrichedActivities;
    }

    // 5. DB 저장 (Supabase)
    const insertData = { 
      destination, 
      duration: `${startDate} ~ ${endDate}`, 
      style, 
      companions, 
      itinerary_data: itineraryJson 
    };
    
    // 로그인한 유저라면 ID도 같이 저장
    if (user_id) insertData.user_id = user_id;

    const { data, error } = await supabase
      .from('trip_plans')
      .insert([insertData])
      .select();

    if (error) throw error;

    console.log("✅ 일정 생성 및 저장 완료!");
    res.status(200).json({ success: true, data: data[0] });

  } catch (error) {
    console.error("🔥 서버 에러 발생:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- [API 2] 내 여행 목록 조회 (GET) ---
app.get('/api/my-trips', async (req, res) => {
  const { user_id } = req.query;
  
  if (!user_id) {
    return res.status(400).json({ error: "로그인이 필요합니다." });
  }

  const { data, error } = await supabase
    .from('trip_plans')
    .select('*')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  
  res.status(200).json({ success: true, data });
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`🚀 TripGen Server running on port ${PORT}`);
});