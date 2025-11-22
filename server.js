require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
// Render 배포 환경 호환
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- [설정] ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
// 모델 설정 (최신 안정화 버전)
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const TIER_LIMITS = { free: 3, pro: 30, admin: Infinity };

// --- [Helpers] ---
function calculateDays(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffTime = Math.abs(endDate - startDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
}

// JSON 파싱 헬퍼
function cleanAndParseJSON(text) {
  try {
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("JSON Parse Fail. Raw Text Start:", text.substring(0, 500));
    throw new Error("AI 응답이 올바르지 않습니다. 다시 시도해주세요.");
  }
}

async function fetchPlaceDetails(placeName) {
  // 체크인 등은 검색 제외
  if (placeName.includes("체크인") || placeName.includes("숙소 복귀")) {
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
          "X-Goog-FieldMask": "places.id,places.photos,places.rating,places.userRatingCount,places.googleMapsUri,places.location,places.websiteUri,places.types,places.displayName" 
        }
      }
    );
    
    const place = response.data.places && response.data.places[0];
    
    // 검색 결과가 없으면 원본 이름 그대로 반환
    if (!place) return { place_name: placeName }; 

    let photoUrl = null;
    if (place.photos && place.photos.length > 0) {
      const photoReference = place.photos[0].name;
      photoUrl = `https://places.googleapis.com/v1/${photoReference}/media?key=${GOOGLE_MAPS_API_KEY}&maxHeightPx=400&maxWidthPx=400`;
    }

    return {
      place_id: place.id,
      // 구글에 등록된 정확한 업체명으로 덮어쓰기 (중요)
      place_name: place.displayName?.text || placeName, 
      rating: place.rating || "정보 없음",
      ratingCount: place.userRatingCount || 0,
      googleMapsUri: place.googleMapsUri || "#",
      websiteUri: place.websiteUri || null, 
      location: place.location,
      photoUrl: photoUrl,
      types: place.types || [] 
    };
  } catch (error) {
    console.error(`⚠️ [${placeName}] 검색 실패:`, error.message);
    return { place_name: placeName };
  }
}

async function calculateRoute(originId, destId) {
  if (!originId || !destId) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=place_id:${originId}&destination=place_id:${destId}&mode=transit&language=ko&key=${GOOGLE_MAPS_API_KEY}`;
    const response = await axios.get(url);
    if (response.data.status === 'OK' && response.data.routes.length > 0) {
      const leg = response.data.routes[0].legs[0];
      return { duration: leg.duration.text, distance: leg.distance.text };
    }
    return null;
  } catch (error) {
    return null;
  }
}

// --- [API 1] 여행 일정 생성 ---
app.post('/api/generate-trip', async (req, res) => {
  console.log("Generate Trip Request Received");
  try {
    const { destination, startDate, endDate, arrivalTime, departureTime, otherRequirements, user_id } = req.body;

    if (!user_id) return res.status(401).json({ error: "로그인이 필요합니다." });

    // 사용자 제한 체크
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

    // ✨ [프롬프트 강력 수정] 구체적 상호명 요구
    const prompt = `
      여행지: ${destination}
      기간: ${startDate} ~ ${endDate} (총 ${totalDays}일)
      시간: ${arrivalTime} 시작, ${departureTime} 종료.
      ✨ 사용자 요청: "${otherRequirements || "없음"}" (최우선 반영)

      **[🚨 장소명 작성 절대 규칙 - 매우 중요]**
      1. **추상적인 표현 금지:** '수원 통닭거리', '시내 호텔', '근처 카페', '맛있는 횟집' 같은 표현을 절대 쓰지 마세요.
      2. **구체적인 상호명 필수:** 반드시 실제로 존재하는 **특정 가게 이름**을 적으세요.
         - (X) 수원 통닭거리 -> (O) 진미통닭
         - (X) 부산 호텔 -> (O) 파라다이스 호텔 부산
         - (X) 성수동 카페 -> (O) 어니언 성수
         - (X) 점심 식사 -> (O) 명동교자 본점
      3. 숙소도 반드시 **구체적인 호텔/숙소 이름**을 지정하세요. (예: '숙소 체크인 (신라스테이 해운대)')

      [기타 규칙]
      - photoUrl, rating, location 등 데이터 필드는 비워두거나 제외하세요. (백엔드가 채움)
      - 예약이 필수인 곳(호텔, 파인다이닝, 테마파크)만 is_booking_required: true

      [출력 형식 - JSON]
      { "trip_title": "제목", "itinerary": [ { "day": 1, "date": "YYYY-MM-DD", "activities": [ { "time": "HH:MM", "place_name": "구체적상호명", "type": "관광/식사/숙소", "activity_description": "설명", "is_booking_required": true/false } ] } ] }
    `;
    
    console.log("Calling Gemini for Generation...");
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const text = result.response.text();
    const itineraryJson = cleanAndParseJSON(text);
    console.log("Gemini Response Parsed.");

    // 3. 데이터 보정 (병렬 처리)
    console.log("Fetching Place Details (Parallel)...");
    
    await Promise.all(itineraryJson.itinerary.map(async (dayPlan) => {
      const enrichedActivities = await Promise.all(dayPlan.activities.map(async (activity) => {
        if (activity.place_name.includes("이동") && !activity.place_name.includes("숙소")) return null; 

        // 장소 정보 조회
        const details = await fetchPlaceDetails(activity.place_name);
        
        // 스마트 링크 로직
        let finalBookingUrl = null;
        const isPark = details.types && (details.types.includes('park') || details.types.includes('natural_feature'));
        
        if (!isPark && activity.is_booking_required) {
          if (details.websiteUri) finalBookingUrl = details.websiteUri;
          else if (details.googleMapsUri) finalBookingUrl = details.googleMapsUri;
          else finalBookingUrl = `https://www.google.com/search?q=${destination}+${activity.place_name}+예약`;
        }
        activity.booking_url = finalBookingUrl;

        // ✨ [중요] details에서 가져온 '정확한 구글 지도 상호명'으로 place_name을 교체 (오타 보정 효과)
        return { ...activity, ...details, place_name: details.place_name || activity.place_name };
      }));

      dayPlan.activities = enrichedActivities.filter(a => a !== null);

      // 경로 계산
      for (let i = 1; i < dayPlan.activities.length; i++) {
        const prev = dayPlan.activities[i - 1];
        const curr = dayPlan.activities[i];
        if (prev.place_id && curr.place_id) {
          const routeInfo = await calculateRoute(prev.place_id, curr.place_id);
          if (routeInfo) curr.travel_info = routeInfo; 
        }
      }
    }));

    // 4. DB 저장
    const { data, error } = await supabase.from('trip_plans').insert([{ 
        destination, duration: `${startDate} ~ ${endDate}`, 
        style: "맞춤 여행", companions: "제한 없음", 
        itinerary_data: itineraryJson, user_id 
    }]).select();

    if (error) throw error;
    await supabase.from('user_limits').update({ usage_count: userLimit.usage_count + 1 }).eq('user_id', user_id);

    console.log("Trip Generated Successfully!");
    res.status(200).json({ success: true, data: data[0] });

  } catch (error) {
    console.error("🔥 Generate Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- [API 2] 일정 수정 (Modify) ---
app.post('/api/modify-trip', async (req, res) => {
  console.log("Modify Trip Request Received");
  try {
    const { currentItinerary, userRequest, destination, user_id } = req.body;

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

    // ✨ [프롬프트 강력 수정] 수정 시에도 구체적 상호명 요구
    const prompt = `
      당신은 여행 전문가입니다. 아래 일정을 사용자의 요청에 맞춰 수정해주세요.
      
      [여행지]: ${destination}
      [기존 일정]: ${JSON.stringify(simplifiedItinerary)}
      ✨ [수정 요청]: "${userRequest}"
      
      **[🚨 장소명 작성 절대 규칙]**
      1. **추상적 표현 금지:** '근처 맛집', '시내 카페', '유명한 식당' (X)
      2. **구체적 상호명 필수:** '다운타우너 버거', '블루보틀 성수', '롯데호텔 서울' (O)
      3. 사용자가 '맛집 추천해줘'라고 하면, 반드시 **실존하는 특정 식당 이름**으로 바꿔주세요.

      [출력 형식]
      JSON 구조 유지. 오직 JSON만 출력.
    `;

    console.log("Calling Gemini for Modification...");
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const text = result.response.text();
    const modifiedJson = cleanAndParseJSON(text);
    console.log("Gemini Modification Parsed.");

    // 수정된 일정 재검증
    console.log("Verifying Modified Places (Parallel)...");
    
    await Promise.all(modifiedJson.itinerary.map(async (dayPlan) => {
      const enrichedActivities = await Promise.all(dayPlan.activities.map(async (activity) => {
        if (activity.place_name.includes("이동") && !activity.place_name.includes("숙소")) return null;

        const details = await fetchPlaceDetails(activity.place_name);
        
        let finalBookingUrl = null;
        const isPark = details.types && (details.types.includes('park') || details.types.includes('natural_feature'));
        
        if (!isPark && activity.is_booking_required) {
          if (details.websiteUri) finalBookingUrl = details.websiteUri;
          else if (details.googleMapsUri) finalBookingUrl = details.googleMapsUri;
          else finalBookingUrl = `https://www.google.com/search?q=${destination}+${activity.place_name}+예약`;
        }
        activity.booking_url = finalBookingUrl;

        // ✨ [중요] 구글 지도에서 가져온 정확한 명칭으로 교체
        return { ...activity, ...details, place_name: details.place_name || activity.place_name };
      }));

      dayPlan.activities = enrichedActivities.filter(a => a !== null);
      
      for (let i = 1; i < dayPlan.activities.length; i++) {
        const prev = dayPlan.activities[i - 1];
        const curr = dayPlan.activities[i];
        if (prev.place_id && curr.place_id) {
          const routeInfo = await calculateRoute(prev.place_id, curr.place_id);
          if (routeInfo) curr.travel_info = routeInfo; 
        }
      }
    }));

    console.log("Modification Complete!");
    res.status(200).json({ success: true, data: modifiedJson });

  } catch (error) {
    console.error("Modify Error:", error);
    res.status(500).json({ success: false, error: "수정 중 오류가 발생했습니다." });
  }
});

// --- [API 3] 자동완성 ---
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