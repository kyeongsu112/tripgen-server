require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
// Render 배포 환경 호환
const PORT = process.env.PORT || 8080;

// 대용량 데이터 처리를 위해 limit 설정 증가
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- [설정 확인 및 초기화] ---
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

// JSON 파싱 헬퍼
function cleanAndParseJSON(text) {
  try {
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("JSON Parse Fail. Raw Text Start:", text.substring(0, 500));
    throw new Error("AI 응답 형식이 올바르지 않습니다.");
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
    console.error(`⚠️ 검색 실패: ${placeName}`);
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
  console.log("Generate Request");
  try {
    const { destination, startDate, endDate, arrivalTime, departureTime, otherRequirements, user_id } = req.body;

    if (!user_id) return res.status(401).json({ error: "로그인이 필요합니다." });

    // 유저 제한 확인
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

    // ✨ [핵심] 당일치기 시간 제약 처리
    let timeConstraint = "";
    if (totalDays === 1) {
        timeConstraint = `**[🚨 당일치기 필수 규칙]**\n1. 일정은 반드시 **${arrivalTime}에 시작**해서 **${departureTime}에 종료**되어야 합니다.\n2. ${arrivalTime} 이전이나 ${departureTime} 이후의 일정은 생성하지 마세요.`;
    } else {
        timeConstraint = `**[시간 규칙]**\n1. Day 1: ${arrivalTime} 이후 시작.\n2. Day ${totalDays}: ${departureTime} 이전 종료.\n3. 나머지 날: 아침부터 저녁(22시)까지 꽉 채움.`;
    }

    const prompt = `
      여행지: ${destination}
      기간: ${startDate} ~ ${endDate} (총 ${totalDays}일)
      ${timeConstraint}
      ✨ 사용자 요청: "${otherRequirements || "없음"}" (최우선 반영)

      [일정 생성 규칙]
      1. **장소:** '맛집' 같은 추상적 표현 금지. 반드시 **실존하는 구체적 상호명** 기입.
      2. **중복:** 같은 장소 반복 금지.
      3. **데이터:** photoUrl 등 상세 정보 필드는 비워두세요.

      [출력 JSON]
      { "trip_title": "제목", "itinerary": [ { "day": 1, "date": "YYYY-MM-DD", "activities": [ { "time": "HH:MM", "place_name": "장소명", "type": "관광/식사/숙소", "activity_description": "설명", "is_booking_required": true/false } ] } ] }
    `;
    
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const itineraryJson = cleanAndParseJSON(result.response.text());

    // 병렬 처리
    await Promise.all(itineraryJson.itinerary.map(async (dayPlan) => {
      // 중복 제거
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

    const { data, error } = await supabase.from('trip_plans').insert([{ 
        destination, duration: `${startDate} ~ ${endDate}`, 
        style: "맞춤 여행", companions: "제한 없음", 
        itinerary_data: itineraryJson, user_id 
    }]).select();

    if (error) throw error;
    await supabase.from('user_limits').update({ usage_count: userLimit.usage_count + 1 }).eq('user_id', user_id);

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
      [여행지]: ${destination}
      [기존]: ${JSON.stringify(simplifiedItinerary)}
      ✨ [수정 요청]: "${userRequest}"
      [규칙] 시간 준수, 중복 금지, 구체적 상호명.
      [출력] JSON Only.
    `;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const modifiedJson = cleanAndParseJSON(result.response.text());

    await Promise.all(modifiedJson.itinerary.map(async (dayPlan) => {
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

        // 기존 정보 재사용 (속도 향상)
        if (existingPlacesMap.has(activity.place_name)) {
            const cached = existingPlacesMap.get(activity.place_name);
            return { ...cached, ...activity };
        }

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

    // ✨ DB 업데이트 (저장)
    if (trip_id) {
        await supabase.from('trip_plans').update({ itinerary_data: modifiedJson }).eq('id', trip_id).eq('user_id', user_id);
    }

    res.status(200).json({ success: true, data: modifiedJson });

  } catch (error) {
    console.error("Modify Error:", error);
    res.status(500).json({ success: false, error: "수정 중 오류가 발생했습니다." });
  }
});

// --- [API 3] 자동완성 (Places API New) ---
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
        // ✨ 도시/지역만 검색되도록 필터링
        includedPrimaryTypes: ["locality", "administrative_area_level_1", "administrative_area_level_2"]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY
        }
      }
    );
    
    const suggestions = response.data.suggestions || [];
    const predictions = suggestions.map(item => ({
      description: item.placePrediction.text.text, 
      place_id: item.placePrediction.placeId 
    }));

    res.status(200).json({ predictions });

  } catch (error) {
    console.error("Autocomplete Error:", error.response?.data || error.message);
    res.status(200).json({ predictions: [] });
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