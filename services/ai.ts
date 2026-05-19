import { getFunctions, httpsCallable } from "firebase/functions";
import { Caregiver, Senior, Appointment, WeeklySchedule } from "../types";
import { sanitizeForAI, sanitizePlainText, sanitizeName } from "../utils/sanitize";

const apptCostToHours = (cost: number, rate: number = 25) => Math.round(cost / rate);

const _callAiProxy = httpsCallable<
  { system: string; user: string; model?: string; maxTokens?: number },
  { text: string }
>(getFunctions(), "aiProxy");

async function askClaude(
  system: string,
  user: string,
  model: "claude-haiku-4-5-20251001" | "claude-sonnet-4-6" = "claude-haiku-4-5-20251001",
  maxTokens = 1000
): Promise<string> {
  const result = await _callAiProxy({ system, user, model, maxTokens });
  return result.data.text;
}

export const aiService = {
  /**
   * 1. Smart Job Parsing
   * Takes natural language (e.g. "Need a driver next tuesday") and returns structured Job Data.
   */
  parseJobRequest: async (naturalText: string) => {
    const sanitizedText = sanitizeForAI(naturalText);
    try {
      const raw = await askClaude(
        `Extract job details from the user's text and return a JSON object with these fields:
title (short professional job title), description (detailed task description),
date (YYYY-MM-DD — calculate from "today" if relative terms used, today is ${new Date().toLocaleDateString()}),
startTime (HH:MM 24hr), endTime (HH:MM 24hr), rate (hourly USD number), location (city or zip).
Respond with valid JSON only. No markdown, no explanation.`,
        `Text: "${sanitizedText}"`,
        "claude-haiku-4-5-20251001",
        500
      );
      return JSON.parse(raw);
    } catch (error) {
      console.error("AI Job Parse Error:", error);
      throw new Error("Could not interpret job request.");
    }
  },

  /**
   * 2. Professional Shift Note Generation
   * Takes shorthand notes and rewrites them professionally.
   */
  generateShiftNote: async (shorthand: string) => {
    try {
      const sanitized = sanitizeForAI(shorthand);
      const text = await askClaude(
        `Rewrite the following caregiver notes into a professional, HIPAA-compliant medical shift log.
Keep it factual, concise, and objective. Use medical terminology where appropriate (e.g. "ambulated", "consumed").`,
        `Raw Notes: "${sanitized}"`,
        "claude-haiku-4-5-20251001",
        400
      );
      return text.trim() || shorthand;
    } catch (error) {
      console.error("AI Note Gen Error:", error);
      return shorthand;
    }
  },

  /**
   * 3. Caregiver Search Agent
   * Analyzes user query against a list of caregivers and returns recommendations + chat response.
   */
  searchCaregivers: async (query: string, caregivers: Caregiver[], seniorProfile?: Senior) => {
    const sanitizedQuery = sanitizeForAI(query);
    const caregiverList = caregivers.map(c => {
      const allSkills = [
        ...(c.medicalSkills || []),
        ...(c.personalityTags || []),
        ...(c.certifications || []),
      ];
      return `ID: ${c.id}, Name: ${sanitizeName(c.name)}, Rate: $${c.hourlyRate}/hr, Skills: ${allSkills.join(", ") || "N/A"}, Rating: ${c.rating || "N/A"}, Distance: ${c.distance}mi, Verified: ${c.verified}`;
    }).join("\n");

    const seniorContext = seniorProfile
      ? `\nSENIOR PROFILE:\n- Name: ${sanitizeName(seniorProfile.name)}\n- Needs: ${seniorProfile.needs?.join(", ") || "None"}\n- Gender Preference: ${seniorProfile.genderPreference || "None"}`
      : "";

    try {
      const raw = await askClaude(
        `You are an expert care matching assistant. Find the best caregivers for the client's needs and explain WHY each is a great match.
Prioritize verified caregivers, closer distance, higher rating, relevant skills.
Respond with valid JSON only. No markdown, no explanation.
JSON shape: { "responseText": string, "recommendedIds": string[], "recommendations": [{ "id": string, "reason": string, "highlights": string[] }], "suggestions": string[] }`,
        `CLIENT REQUEST: "${sanitizedQuery}"${seniorContext}\n\nAVAILABLE CAREGIVERS:\n${caregiverList}`,
        "claude-sonnet-4-6",
        1500
      );
      return JSON.parse(raw);
    } catch (error) {
      console.error("AI Search Error:", error);
      return {
        responseText: "I'm having trouble connecting right now, but you can browse the list manually!",
        recommendedIds: [],
        recommendations: [],
        suggestions: [],
      };
    }
  },

  /**
   * 4. AI Rate Suggestion
   * Analyzes caregiver profile and suggests competitive hourly rate.
   */
  suggestRate: async (caregiverProfile: {
    location: string;
    skills: string[];
    certifications?: string[];
    experience?: number;
  }) => {
    try {
      const raw = await askClaude(
        `You are a market rate analyst for caregiving services. Analyze the caregiver profile and suggest a competitive hourly rate.
Respond with valid JSON only. No markdown, no explanation.
JSON shape: { "suggestedRate": number, "explanation": string, "marketRange": { "low": number, "average": number, "high": number } }`,
        `Location: ${caregiverProfile.location}
Skills: ${caregiverProfile.skills.join(", ")}
Certifications: ${caregiverProfile.certifications?.join(", ") || "None"}
Experience: ${caregiverProfile.experience || "Not specified"} years`,
        "claude-haiku-4-5-20251001",
        300
      );
      return JSON.parse(raw);
    } catch (error) {
      console.error("AI Rate Suggestion Error:", error);
      const base = 25;
      const skillBonus = caregiverProfile.skills.length * 2;
      const certBonus = (caregiverProfile.certifications?.length || 0) * 3;
      const expBonus = (caregiverProfile.experience || 0) * 1;
      const suggested = base + skillBonus + certBonus + expBonus;
      return {
        suggestedRate: suggested,
        explanation: `Based on your ${caregiverProfile.skills.length} skills and ${caregiverProfile.certifications?.length || 0} certifications, $${suggested}/hr is competitive for ${caregiverProfile.location}.`,
        marketRange: { low: suggested - 5, average: suggested, high: suggested + 5 },
      };
    }
  },

  /**
   * 5. Conversational Booking
   * Multi-turn conversation to collect booking details and complete booking.
   */
  conversationalBooking: async (
    conversation: Array<{ role: "user" | "assistant"; content: string }>,
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
    const sanitizedConversation = conversation.map(msg => ({
      ...msg,
      content: sanitizeForAI(msg.content),
    }));

    try {
      const conversationHistory = sanitizedConversation
        .map(msg => `${msg.role === "user" ? "Client" : "AI"}: ${msg.content}`)
        .join("\n");

      const historyContext = userContext?.previousBookings?.slice(0, 3)
        .map(b => `- ${b.date}: ${b.caregiverName} (${apptCostToHours(b.cost, 25)}hrs, ${b.status})`)
        .join("\n") || "No previous bookings yet.";

      const prefContext = userContext?.preferredCaregivers?.length
        ? `Prefers: ${userContext.preferredCaregivers.join(", ")}`
        : "No specific preferences recorded yet.";

      const scheduleContext = userContext?.targetCaregiverSchedule
        ? `CAREGIVER WEEKLY SCHEDULE:\n${Object.entries(userContext.targetCaregiverSchedule)
            .map(([day, slots]) => `- ${day.toUpperCase()}: ${(slots as any[]).length > 0 ? (slots as any[]).map((s: any) => `${s.start}-${s.end}`).join(", ") : "Not available"}`)
            .join("\n")}`
        : "No specific caregiver schedule provided.";

      const seniorCtx = userContext?.seniorProfile
        ? `SENIOR PROFILE:\n- Name: ${sanitizeName(userContext.seniorProfile.name)}\n- Needs: ${userContext.seniorProfile.needs?.join(", ") || "None"}\n- Gender Preference: ${userContext.seniorProfile.genderPreference || "None"}`
        : "";

      const system = `You are an expert care booking assistant. Make booking caregivers effortless and personalized.
Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.
Be proactive, contextual, and efficient. Minimize back-and-forth. Detect urgency keywords (ASAP, emergency, fall, hurt, help now).
Check the caregiver schedule before confirming times.
Respond with valid JSON only. No markdown, no explanation.
JSON shape: { "response": string, "isEmergency": boolean, "missingInfo": string[], "nextQuestion": string|null, "readyToShowMatches": boolean, "readyToConfirm": boolean, "extractedInfo": { "service": string, "date": string, "time": string, "duration": number }, "suggestions": string[] }`;

      const userMsg = `${seniorCtx}
Recent Bookings: ${historyContext}
Preferences: ${prefContext}
${scheduleContext}

CURRENT BOOKING STATE:
- Service: ${currentBookingState.service || "Not specified"}
- Date: ${currentBookingState.date || "Not specified"}
- Time: ${currentBookingState.time || "Not specified"}
- Duration: ${currentBookingState.duration ? currentBookingState.duration + " hours" : "Not specified"}
- Selected caregiver: ${currentBookingState.selectedCaregiverId || "Not selected"}

CONVERSATION:
${conversationHistory}`;

      const raw = await askClaude(system, userMsg, "claude-sonnet-4-6", 1000);
      return JSON.parse(raw);
    } catch (error) {
      console.error("AI Conversational Booking Error:", error);
      return {
        response: "I'm here to help you book a caregiver! Could you tell me what type of care you need?",
        isEmergency: false,
        missingInfo: ["service", "date", "time", "duration"],
        nextQuestion: "What type of care do you need?",
        readyToShowMatches: false,
        readyToConfirm: false,
        extractedInfo: {},
        suggestions: [
          "Most clients book 2-4 hour sessions",
          "Morning slots (9am-12pm) are popular",
          "We can set up recurring bookings if needed",
        ],
      };
    }
  },
};
