require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
// Render 배포 환경 호환
const PORT = process.env.PORT || 8080;

// 데이터 용량 제한 늘림 (이미지 처리 등 대비)
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- [설정] ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
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

// JSON 파싱 헬퍼 (안전장치)
function cleanAndParseJSON(text) {
  try {
    // ```json ... ``` 마크다운 제거
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("JSON Parse Fail. Raw Text Start:", text.substring(0, 500));
    throw new Error("AI 응답이 올바르지 않습니다. 다시 시도해주세요.");
  }
}

async function fetchPlaceDetails(placeName) {
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
          "X-Goog-FieldMask": "places.id,places.photos,places.rating,places.userRatingCount,places.googleMapsUri,places.location,places.websiteUri,places.types,places.displayName" 
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
      place_name: place.displayName?.text || placeName, // 구글 정식 명칭
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

    const totalDays = calculateDays(startDate, endDate);

    // ✨ [프롬프트 수정] 시간 꽉 채우기 & 중복 금지 명령 강화
    const prompt = `
      여행지: ${destination}
      기간: ${startDate} ~ ${endDate} (총 ${totalDays}일)
      시간: ${arrivalTime} 시작, ${departureTime} 종료.
      요청사항: "${otherRequirements || "없음"}"

      **[🚨 일정 작성 필수 규칙 - 매우 중요]**
      1. **시간 엄수:** 반드시 **아침(Morning)부터 저녁(Evening, 20:00~22:00)까지** 일정을 꽉 채우세요. 12시에 끝내지 마세요.
      2. **중복 금지:** 같은 장소를 연속으로 방문하거나 하루에 두 번 넣지 마세요. (예: N서울타워 -> N서울타워 (X))
      3. **구체적 상호명:** '맛집' 대신 '명동교자', '호텔' 대신 '신라스테이' 처럼 구체적으로 적으세요.
      4. **동선:** 하루에 3~5곳 이상 방문하도록 알차게 구성하세요.

      [출력 형식 - JSON]
      { "trip_title": "제목", "itinerary": [ { "day": 1, "date": "YYYY-MM-DD", "activities": [ { "time": "HH:MM", "place_name": "장소명", "type": "관광/식사/숙소", "activity_description": "설명", "is_booking_required": true/false } ] } ] }
    `;
    
    console.log("Calling Gemini for Generation...");
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const text = result.response.text();
    const itineraryJson = cleanAndParseJSON(text);
    console.log("Gemini Response Parsed.");

    console.log("Fetching Place Details (Parallel)...");
    
    await Promise.all(itineraryJson.itinerary.map(async (dayPlan) => {
      
      // ✨ [중복 제거 로직 추가] AI가 실수로 중복을 주더라도 여기서 거릅니다.
      const uniqueActivities = [];
      const seenPlaces = new Set();

      dayPlan.activities.forEach(act => {
        // '이동'은 제외하고, 실제 장소 이름만 검사
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

      // 병렬 처리로 정보 가져오기
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

    // AI에게 보낼 때는 무거운 데이터 제거 (토큰 절약)
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

    const prompt = `
      당신은 여행 전문가입니다. 아래 일정을 사용자의 요청에 맞춰 수정해주세요.
      
      [여행지]: ${destination}
      [기존 일정]: ${JSON.stringify(simplifiedItinerary)}
      ✨ [수정 요청]: "${userRequest}"
      
      **[규칙]**
      1. 요청 사항을 반영하되, 일정은 **저녁(20시~22시)까지 꽉 채워진 상태**를 유지하세요.
      2. **같은 장소 반복 금지.**
      3. **구체적 상호명 사용.**

      [출력] JSON 구조 유지. 오직 JSON만 출력.
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
      
      // ✨ [중복 제거 로직 동일 적용]
      const uniqueActivities = [];
      const seenPlaces = new Set();
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