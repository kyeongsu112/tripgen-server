// server.js - 날짜 계산 및 탭 구조 지원 버전
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = 8080;

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// [Helper] 날짜 차이 계산 함수
function calculateDays(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffTime = Math.abs(endDate - startDate);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // 당일 포함
  return diffDays;
}

// [함수] 구글 맵 장소 검증 (기존 유지)
async function fetchPlaceDetails(placeName) {
  try {
    const response = await axios.post(
      `https://places.googleapis.com/v1/places:searchText`,
      { textQuery: placeName, languageCode: "ko" },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "places.photos,places.rating,places.userRatingCount,places.googleMapsUri" 
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
      rating: place.rating || "정보 없음",
      ratingCount: place.userRatingCount || 0,
      googleMapsUri: place.googleMapsUri || "#",
      photoUrl: photoUrl
    };
  } catch (error) {
    return null;
  }
}

// [API] 여행 일정 생성
app.post('/api/generate-trip', async (req, res) => {
  try {
    // destination, style, companions는 그대로 받고, duration 대신 startDate, endDate를 받음
    const { destination, startDate, endDate, style, companions } = req.body;
    
    // 날짜 계산
    const totalDays = calculateDays(startDate, endDate);
    const durationText = `${startDate} ~ ${endDate} (${totalDays}일간)`;

    console.log(`📩 요청 수신: ${destination}, ${durationText}`);

    const prompt = `
      여행지: ${destination}
      기간: ${startDate} 부터 ${endDate} 까지 (총 ${totalDays}일)
      스타일: ${style}
      동행: ${companions}
      
      위 조건으로 여행 일정을 계획하세요.
      
      [필수 조건]
      1. 결과는 **반드시 JSON 형식**이어야 합니다.
      2. itinerary 배열의 길이는 정확히 ${totalDays}개여야 합니다.
      3. 각 날짜(day)에 실제 날짜(YYYY-MM-DD)를 포함하세요.

      JSON 구조:
      {
        "trip_title": "제목",
        "itinerary": [
          { 
            "day": 1, 
            "date": "2025-11-17",
            "activities": [
              { "time": "10:00", "place_name": "장소명", "type": "관광", "activity_description": "설명" }
            ] 
          }
        ]
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    const itineraryJson = JSON.parse(text);

    console.log("🤖 AI 일정 생성 완료. 검증 시작...");

    // 장소 검증 로직 (병렬 처리)
    for (const dayPlan of itineraryJson.itinerary) {
      dayPlan.activities = await Promise.all(dayPlan.activities.map(async (activity) => {
        if (activity.type === "숙소" || activity.place_name.includes("공항") || activity.place_name === "이동") {
          return activity; 
        }
        const details = await fetchPlaceDetails(activity.place_name);
        if (details) return { ...activity, ...details };
        return activity;
      }));
    }

    // DB 저장 (duration 컬럼에 날짜 범위 텍스트 저장)
    const { data, error } = await supabase
      .from('trip_plans')
      .insert([{ 
        destination, 
        duration: durationText, // 날짜 범위로 저장
        style, 
        companions, 
        itinerary_data: itineraryJson 
      }])
      .select();

    if (error) throw error;

    res.status(200).json({ success: true, data: data[0] });

  } catch (error) {
    console.error("❌ 서버 에러:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 TripGen 서버가 http://localhost:${PORT} 에서 대기 중입니다!`);
});