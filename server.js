// server.js - 이동 시간 검증(Directions API) 추가 버전
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// [Helper] 장소 상세 정보 가져오기 (기존 유지)
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
    if (!place) return null;

    let photoUrl = null;
    if (place.photos && place.photos.length > 0) {
      const photoReference = place.photos[0].name;
      photoUrl = `https://places.googleapis.com/v1/${photoReference}/media?key=${GOOGLE_MAPS_API_KEY}&maxHeightPx=400&maxWidthPx=400`;
    }

    return {
      place_id: place.id, // 매우 중요! (이동 계산용)
      place_name: placeName, // 원본 이름 유지
      rating: place.rating || "정보 없음",
      ratingCount: place.userRatingCount || 0,
      googleMapsUri: place.googleMapsUri || "#",
      location: place.location,
      photoUrl: photoUrl
    };
  } catch (error) {
    return { place_name: placeName }; // 실패해도 이름은 반환
  }
}

// [New] 이동 경로 계산 (Directions API)
async function calculateRoute(originId, destId) {
  if (!originId || !destId) return null;
  
  try {
    // 구글 Directions API 호출 (대중교통 모드)
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=place_id:${originId}&destination=place_id:${destId}&mode=transit&language=ko&key=${GOOGLE_MAPS_API_KEY}`;
    const response = await axios.get(url);
    
    if (response.data.status === 'OK' && response.data.routes.length > 0) {
      const leg = response.data.routes[0].legs[0];
      return {
        duration: leg.duration.text, // 예: "15분"
        distance: leg.distance.text, // 예: "2.5km"
        description: `이동: ${leg.duration.text} (${leg.distance.text})`
      };
    }
    return null;
  } catch (error) {
    console.error("Route Error:", error.message);
    return null;
  }
}

app.post('/api/generate-trip', async (req, res) => {
  try {
    const { destination, startDate, endDate, style, companions, user_id } = req.body;
    
    // 날짜 계산
    const start = new Date(startDate);
    const end = new Date(endDate);
    const totalDays = Math.ceil(Math.abs(end - start) / (1000 * 60 * 60 * 24)) + 1;

    console.log(`📩 요청: ${destination}, ${totalDays}일`);

    // 1. AI 생성
    const prompt = `
      여행지: ${destination}, 기간: ${startDate}~${endDate}, 스타일: ${style}, 동행: ${companions}
      위 조건으로 여행 일정을 짜고 **JSON만** 출력하세요.
      단, '이동'이나 '숙소 체크인' 같은 항목은 제외하고, **실제 방문할 장소(식당, 관광지)** 위주로만 구성하세요.
      
      JSON 구조:
      {
        "trip_title": "제목",
        "itinerary": [
          { "day": 1, "date": "${startDate}", "activities": [{ "time": "10:00", "place_name": "장소명", "type": "관광/식사", "activity_description": "설명" }] }
        ]
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    const itineraryJson = JSON.parse(text);

    console.log("🤖 AI 일정 생성 완료. 상세 정보 및 이동 경로 검증 중...");

    // 2. 장소 정보 & 이동 경로 보강 (순차 처리)
    for (const dayPlan of itineraryJson.itinerary) {
      // A. 먼저 모든 장소의 상세 정보를 가져옵니다 (Place ID 확보)
      const enrichedActivities = [];
      for (const activity of dayPlan.activities) {
        const details = await fetchPlaceDetails(activity.place_name);
        enrichedActivities.push({ ...activity, ...details });
      }

      // B. 활동 사이사이의 이동 시간 계산 (이전 장소 -> 현재 장소)
      for (let i = 1; i < enrichedActivities.length; i++) {
        const prev = enrichedActivities[i - 1];
        const curr = enrichedActivities[i];

        // 둘 다 Place ID가 있어야 계산 가능
        if (prev.place_id && curr.place_id) {
          const routeInfo = await calculateRoute(prev.place_id, curr.place_id);
          if (routeInfo) {
            // 현재 장소 정보에 '여기까지 오는 데 걸린 시간' 추가
            curr.travel_info = routeInfo; 
          }
        }
      }
      dayPlan.activities = enrichedActivities;
    }

    // 3. DB 저장
    const insertData = { 
      destination, duration: `${startDate} ~ ${endDate}`, style, companions, itinerary_data: itineraryJson 
    };
    if (user_id) insertData.user_id = user_id;

    const { data, error } = await supabase.from('trip_plans').insert([insertData]).select();
    if (error) throw error;

    console.log("✅ 검증 및 저장 완료!");
    res.status(200).json({ success: true, data: data[0] });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 내 여행 목록 (기존 유지)
app.get('/api/my-trips', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: "로그인이 필요합니다." });
  const { data, error } = await supabase.from('trip_plans').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ success: true, data });
});

app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: Port ${PORT}`);
});