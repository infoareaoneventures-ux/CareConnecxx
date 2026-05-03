
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { Caregiver, Senior, Appointment, WeeklySchedule } from "../types";
import { sanitizeForAI, sanitizePlainText, sanitizeName, sanitizeBio } from "../utils/sanitize";

const apptCostToHours = (cost: number, rate: number = 25) => Math.round(cost / rate);


// SECURE: Load API key from environment variable
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

if (!API_KEY) {
  console.error('❌ VITE_GEMINI_API_KEY not found in .env file');
}

const ai = new GoogleGenAI({ apiKey: API_KEY || '' });

const MODEL_NAME = "gemini-2.5-flash";

export const aiService = {
  /**
   * 1. Smart Job Parsing
   * Takes natural language (e.g. "Need a driver next tuesday") and returns structured Job Data.
   */
  parseJobRequest: async (naturalText: string) => {
    // Sanitize user input before sending to AI
    const sanitizedText = sanitizeForAI(naturalText);

    try {
      const response = await ai!.models.generateContent({
        model: MODEL_NAME,
        contents: `Extract job details from this text. If a value is missing, use a reasonable default or leave empty. 
        Today is ${new Date().toLocaleDateString()}. 
        Text: "${sanitizedText}"`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "A short, professional job title" },
              description: { type: Type.STRING, description: "Detailed description of tasks" },
              date: { type: Type.STRING, description: "YYYY-MM-DD format. Calculate based on 'today's date' if words like 'next tuesday' are used." },
              startTime: { type: Type.STRING, description: "HH:MM (24hr format)" },
              endTime: { type: Type.STRING, description: "HH:MM (24hr format)" },
              rate: { type: Type.NUMBER, description: "Hourly rate in USD" },
              location: { type: Type.STRING, description: "City or Zip Code" },
            },
            required: ["title", "description"],
          } as Schema,
        },
      });

      return JSON.parse(response.text || "{}");
    } catch (error) {
      console.error("Gemini Job Parse Error:", error);
      throw new Error("Could not interpret job request.");
    }
  },

  /**
   * 2. Professional Shift Note Generation
   * Takes shorthand notes and rewrites them professionally.
   */
  generateShiftNote: async (shorthand: string) => {
    try {
      const response = await ai!.models.generateContent({
        model: MODEL_NAME,
        contents: `Rewrite the following caregiver notes into a professional, HIPAA-compliant medical shift log. 
        Keep it factual, concise, and objective. Use medical terminology where appropriate (e.g. 'ambulated', 'consumed').
        
        Raw Notes: "${shorthand}"`,
        config: {
          temperature: 0.3 // Low temperature for factual output
        }
      });

      return response.text?.trim() || shorthand;
    } catch (error) {
      console.error("Gemini Note Gen Error:", error);
      return shorthand; // Fallback to original text
    }
  },

  /**
   * 3. Caregiver Search Agent
   * Analyzes user query against a list of caregivers and returns recommendations + chat response.
   */
  searchCaregivers: async (query: string, caregivers: Caregiver[], seniorProfile?: Senior) => {
    // Sanitize user query to prevent prompt injection
    const sanitizedQuery = sanitizeForAI(query);
    
    // Sanitize caregiver names for AI context
    const sanitizedCaregivers = caregivers.map(c => ({
      ...c,
      name: sanitizeName(c.name),
    }));
    


    try {
      // Simplify caregiver object to save tokens and focus on matchable attributes
      const rosterContext = caregivers.map(c => ({
        id: c.id,
        name: c.name,
        tags: c.personalityTags.join(", "),
        skills: c.medicalSkills?.join(", "),
        rate: c.hourlyRate,
        verified: c.verified,
        location: c.distance + " miles away",
        availability: c.availability?.join(", ")
      }));

      // Context Construction
      let contextString = "";
      const caregiverList = caregivers.map(c => {
        const allSkills = [
          ...(c.medicalSkills || []),
          ...(c.personalityTags || []),
          ...(c.certifications || [])
        ];
        const skillsStr = allSkills.length > 0 ? allSkills.join(', ') : 'N/A';
        return `ID: ${c.id}, Name: ${c.name}, Rate: $${c.hourlyRate}/hr, Skills: ${skillsStr}, Rating: ${c.rating || 'N/A'}, Distance: ${c.distance}mi, Verified: ${c.verified}`;
      }).join('\n');

      const prompt = `You are an expert care matching assistant. Your job is to find the BEST caregivers for the client's needs and explain WHY each one is a great match.

🎯 YOUR MISSION:
1. Understand what the client REALLY needs (read between the lines)
2. Find caregivers who are the BEST fit
3. Explain WHY each caregiver is recommended
4. Be specific and helpful

👤 CLIENT REQUEST:
"${sanitizedQuery}"

${seniorProfile ? `
👵 SENIOR PROFILE:
- Name: ${seniorProfile.name}
- Needs: ${seniorProfile.needs?.join(', ') || 'None specified'}
- Personality: ${seniorProfile.personality || 'Not specified'}
- Gender Preference: ${seniorProfile.genderPreference || 'None'}
` : ''}

👥 AVAILABLE CAREGIVERS:
${caregiverList}

🧠 SMART MATCHING RULES:
- Prioritize VERIFIED caregivers
- Consider DISTANCE (closer is better)
- Match SKILLS to needs
- Factor in RATING (higher is better)
- Consider PRICE (but don't sacrifice quality)
- Look for RELEVANT EXPERIENCE

📊 PROVIDE YOUR RESPONSE AS JSON:
{
  "responseText": "A warm, helpful message explaining what you found. Be specific about WHY these caregivers are good matches.",
  "recommendedIds": ["id1", "id2", "id3"],
  "recommendations": [
    {
      "id": "caregiver_id",
      "reason": "Specific reason why this caregiver is perfect (mention skills, experience, ratings, etc.)",
      "highlights": ["Key strength 1", "Key strength 2", "Key strength 3"]
    }
  ],
  "suggestions": ["Helpful tip 1", "Helpful tip 2"]
}

EXAMPLE RESPONSE:

Query: "I need a driver for my mom"
Response: {
  "responseText": "I found 3 excellent drivers for your mom! Here are my top recommendations:",
  "recommendedIds": ["123", "456", "789"],
  "recommendations": [
    {
      "id": "123",
      "reason": "Sarah is perfect because she specializes in senior transportation and has driven for clients in your area 50+ times",
      "highlights": ["⭐ 4.9 rating", "✓ Verified driver", "📍 Only 2 miles away", "💰 Great value at $30/hr"]
    },
    {
      "id": "456",
      "reason": "Maria is highly recommended - she's bilingual and has experience with seniors who need mobility assistance",
      "highlights": ["🗣️ Speaks Spanish", "♿ Mobility support", "⭐ 4.8 rating"]
    }
  ],
  "suggestions": ["Most clients book 2-3 hour driving sessions", "Consider scheduling recurring trips for regular appointments"]
}`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              responseText: { type: Type.STRING },
              recommendedIds: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              recommendations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    reason: { type: Type.STRING },
                    highlights: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    }
                  }
                }
              },
              suggestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              }
            }
          } as Schema
        }
      });

      return JSON.parse(response.text || '{}');
    } catch (error) {
      console.error("Gemini Search Error:", error);
      return {
        responseText: "I'm having trouble connecting to my AI brain right now, but you can browse the list manually!",
        recommendedIds: [],
        recommendations: [],
        suggestions: []
      };
    }
  },

  /**
   * 4. AI Rate Suggestion
   * Analyzes caregiver profile and suggests competitive hourly rate
   */
  suggestRate: async (caregiverProfile: {
    location: string;
    skills: string[];
    certifications?: string[];
    experience?: number;
  }) => {
    try {
      const prompt = `You are a market rate analyst for caregiving services. Analyze this caregiver profile and suggest a competitive hourly rate.

Caregiver Profile:
- Location: ${caregiverProfile.location}
- Skills: ${caregiverProfile.skills.join(', ')}
- Certifications: ${caregiverProfile.certifications?.join(', ') || 'None'}
- Experience: ${caregiverProfile.experience || 'Not specified'} years

Provide:
1. A suggested hourly rate (just the number, e.g., 28)
2. A brief explanation (2-3 sentences) of why this rate is competitive
3. Market range (low, average, high)

Format your response as JSON with this structure:
{
  "suggestedRate": number,
  "explanation": string,
  "marketRange": { "low": number, "average": number, "high": number }
}`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              suggestedRate: { type: Type.NUMBER },
              explanation: { type: Type.STRING },
              marketRange: {
                type: Type.OBJECT,
                properties: {
                  low: { type: Type.NUMBER },
                  average: { type: Type.NUMBER },
                  high: { type: Type.NUMBER }
                }
              }
            }
          } as Schema
        }
      });

      return JSON.parse(response.text || '{}');
    } catch (error) {
      console.error('Gemini Rate Suggestion Error:', error);
      // Fallback to simple calculation
      const baseRate = 25;
      const skillBonus = caregiverProfile.skills.length * 2;
      const certBonus = (caregiverProfile.certifications?.length || 0) * 3;
      const expBonus = (caregiverProfile.experience || 0) * 1;
      const suggested = baseRate + skillBonus + certBonus + expBonus;

      return {
        suggestedRate: suggested,
        explanation: `Based on your ${caregiverProfile.skills.length} skills and ${caregiverProfile.certifications?.length || 0} certifications, we suggest $${suggested}/hr as a competitive rate for ${caregiverProfile.location}.`,
        marketRange: {
          low: suggested - 5,
          average: suggested,
          high: suggested + 5
        }
      };
    }
  },

  /**
   * 5. Conversational Booking
   * Multi-turn conversation to collect booking details and complete booking
   */
  conversationalBooking: async (
    conversation: Array<{ role: 'user' | 'assistant', content: string }>,
    currentBookingState: {
      service?: string;
      date?: string;
      time?: string;
      duration?: number;
      selectedCaregiverId?: string;
    },
    userContext?: {
      previousBookings?: Appointment[];
      preferredCaregivers?: string[];
      seniorProfile?: Senior;
      targetCaregiverSchedule?: WeeklySchedule;
    }
  ) => {
    // Sanitize conversation content before sending to AI
    const sanitizedConversation = conversation.map(msg => ({
      ...msg,
      content: sanitizeForAI(msg.content)
    }));
    
    try {
      const conversationHistory = sanitizedConversation.map(msg =>
        `${msg.role === 'user' ? 'Client' : 'AI'}: ${msg.content}`
      ).join('\n');

      const historyContext = userContext?.previousBookings?.slice(0, 3).map(b =>
        `- ${b.date}: ${b.caregiverName} (${apptCostToHours(b.cost, 25)}hrs, ${b.status})`
      ).join('\n') || 'No previous bookings yet.';

      const prefContext = userContext?.preferredCaregivers?.length
        ? `Prefers: ${userContext.preferredCaregivers.join(', ')}`
        : 'No specific preferences recorded yet.';

      const scheduleContext = userContext?.targetCaregiverSchedule
        ? `CAREGIVER WEEKLY SCHEDULE:
${Object.entries(userContext.targetCaregiverSchedule).map(([day, slots]) =>
          `- ${day.toUpperCase()}: ${slots.length > 0 ? (slots as any[]).map(s => `${s.start}-${s.end}`).join(', ') : 'Not available'}`
        ).join('\n')}`
        : 'No specific caregiver schedule provided yet.';

      const prompt = `You are an expert care booking assistant with a warm, helpful personality. Your mission is to make booking caregivers effortless and personalized.

📅 TODAY'S DATE: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
⏰ CURRENT TIME: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}

USER CONTEXT:
${userContext?.seniorProfile ? `
👵 SENIOR PROFILE:
- Name: ${sanitizeName(userContext.seniorProfile.name)}
- Needs: ${userContext.seniorProfile.needs?.join(', ') || 'None specified'}
- Personality: ${sanitizePlainText(userContext.seniorProfile.personality) || 'Not specified'}
- Gender Preference: ${userContext.seniorProfile.genderPreference || 'None'}
` : ''}
Recent Bookings:
${historyContext}
Preferences:
${prefContext}

${scheduleContext}

🎯 YOUR GOALS:
1. Be PROACTIVE - Suggest options before being asked
2. Be CONTEXTUAL - Use available information intelligently
3. Be HELPFUL - Solve problems (If requested time is outside the provided schedule, suggest the nearest available slots on that day)
4. Be SMART - Offer "Bundled Services" (e.g., if booking a driver, ask "Would you like our caregiver to also help with meal prep while they're with you?")
5. Be CLEAR - Explain recommendations with reasons
6. Be EFFICIENT - Minimize back-and-forth questions

📋 CURRENT BOOKING STATE:
- Service needed: ${currentBookingState.service || 'Not specified'}
- Date: ${currentBookingState.date || 'Not specified'}
- Time: ${currentBookingState.time || 'Not specified'}
- Duration: ${currentBookingState.duration ? currentBookingState.duration + ' hours' : 'Not specified'}
- Selected caregiver: ${currentBookingState.selectedCaregiverId || 'Not selected'}

💬 CONVERSATION HISTORY:
${conversationHistory}

🧠 SMART BEHAVIORS:
- **EMERGENCY DETECTION**: If the user mentions urgent keywords like "ASAP", "emergency", "fall", "hurt", "help now", "urgent", or "immediately", set isEmergency to TRUE and prioritize speed over completeness.
- STRICTLY extract the user's intent. If they say "Overnight care", do NOT assume it's "Meal preparation".
- Use TODAY'S DATE (${new Date().toLocaleDateString()}) to calculate relative references like "tomorrow" or "next Monday".
- Check the CAREGIVER WEEKLY SCHEDULE (if provided) before confirming a time. If user asks for 2 PM and they are only available 9 AM - 1 PM, say so and suggest 12 PM or another day.
- Suggest service bundling based on known senior needs from the PROFILE.
- Offer quick options when possible.

📊 PROVIDE YOUR RESPONSE AS JSON:
{
  "response": "Your warm, helpful response to the client. Be conversational and friendly. Include specific suggestions based on THEIR request.",
  "isEmergency": boolean (TRUE if urgent keywords detected like 'ASAP', 'emergency', 'fall', 'hurt', 'help now'),
  "missingInfo": ["service", "date", "time", "duration"] (only what's truly missing),
  "nextQuestion": "What to ask next, with suggested options if applicable (or null if complete)",
  "readyToShowMatches": boolean (true if you have service, date, time, duration),
  "readyToConfirm": boolean (true if caregiver is selected),
  "extractedInfo": {
    "service": "extracted service if mentioned (e.g., 'Overnight Care', 'Driving', 'Meal Preparation')",
    "date": "YYYY-MM-DD format based on TODAY'S DATE",
    "time": "HH:MM format if mentioned (convert 'morning' to '09:00', 'overnight' to '20:00', etc.)",
    "duration": number (hours if mentioned, or suggest based on service type)
  },
  "suggestions": ["Helpful suggestion 1", "Helpful suggestion 2"] (proactive tips)
}

EXAMPLE RESPONSE:
User: "I need overnight care tomorrow"
Response: "I can certainly help with that! Tomorrow is ${new Date(Date.now() + 86400000).toLocaleDateString()}. For overnight care, would starting at 8 PM and staying for 10 or 12 hours work for you?"`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              response: { type: Type.STRING },
              isEmergency: { type: Type.BOOLEAN },
              missingInfo: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              nextQuestion: { type: Type.STRING },
              readyToShowMatches: { type: Type.BOOLEAN },
              readyToConfirm: { type: Type.BOOLEAN },
              extractedInfo: {
                type: Type.OBJECT,
                properties: {
                  service: { type: Type.STRING },
                  date: { type: Type.STRING },
                  time: { type: Type.STRING },
                  duration: { type: Type.NUMBER }
                }
              },
              suggestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              }
            }
          } as Schema
        }
      });

      return JSON.parse(response.text || '{}');
    } catch (error) {
      console.error('Gemini Conversational Booking Error:', error);
      return {
        response: "I'm here to help you book a caregiver! Could you tell me what type of care you need? Popular options include driving, meal preparation, companionship, or medical assistance.",
        missingInfo: ['service', 'date', 'time', 'duration'],
        nextQuestion: "What type of care do you need?",
        readyToShowMatches: false,
        readyToConfirm: false,
        extractedInfo: {},
        suggestions: [
          "Most clients book 2-4 hour sessions",
          "Morning slots (9am-12pm) are popular",
          "We can set up recurring bookings if needed"
        ]
      };
    }
  }
};
