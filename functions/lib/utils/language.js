"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.flowLabel = exports.t = void 0;
exports.detectLanguage = detectLanguage;
exports.languageFromSession = languageFromSession;
exports.isSupportedLanguage = isSupportedLanguage;
const openaiClient_1 = require("./openaiClient");
const SUPPORTED = ["en", "es"];
// Cheap heuristic — if the message has clear Spanish-specific characters
// (ñ, ¿, ¡, accented vowels in plausible Spanish positions) we don't need an
// LLM call. Otherwise we fall back to the classifier.
function spanishHeuristicHit(text) {
    return /[ñ¿¡]/i.test(text) || /\b(hola|gracias|necesito|cuidador|abuela|abuelo|mamá|papá|por favor|tengo|quiero|ayuda)\b/i.test(text);
}
function englishHeuristicHit(text) {
    return /\b(the|and|need|hi|hello|yes|no|please|thanks|help|caregiver|mom|dad)\b/i.test(text);
}
// Detect the language of the user's first message. Returns null if unsure —
// caller should default to English in that case. Skips the LLM when a strong
// heuristic hit identifies the language quickly.
async function detectLanguage(text) {
    const t = text.trim();
    if (t.length < 4)
        return null;
    const esHit = spanishHeuristicHit(t);
    const enHit = englishHeuristicHit(t);
    if (esHit && !enHit)
        return "es";
    if (enHit && !esHit)
        return "en";
    try {
        const raw = await (0, openaiClient_1.quickComplete)("What language is this message in? Reply with one of: en, es, other. Reply with only the code.", t, { maxTokens: 5 });
        const code = raw.trim().toLowerCase().slice(0, 3);
        if (code.startsWith("es"))
            return "es";
        if (code.startsWith("en"))
            return "en";
        return null;
    }
    catch (_a) {
        return null;
    }
}
// Reads the language stored on the session (set by detectLanguage at first
// contact). Defaults to English when nothing is set. Use this in any handler
// that needs to pick a localized string.
function languageFromSession(session) {
    const raw = session === null || session === void 0 ? void 0 : session.preferredLanguage;
    if (raw === "es")
        return "es";
    return "en";
}
function isSupportedLanguage(code) {
    return SUPPORTED.includes(code);
}
// ── Localized message bank ───────────────────────────────────────────────────
// Keyed by stable IDs that handlers reference. New keys go here; new languages
// extend the same key set. Functions take parameters where needed.
exports.t = {
    otp_greeting: (code, lang) => lang === "es"
        ? `Hola — soy Cara, tu asistente de cuidado.\n\nPrimero un control de seguridad: por favor responde con el código ${code} para confirmar que eres tú en este número.`
        : `Hi — I'm Cara, your care assistant.\n\nQuick security check first: please reply with the code ${code} so I know it's really you on this number.`,
    otp_verified_role_question: (lang) => lang === "es"
        ? `Verificado — gracias.\n\n¿Estás buscando cuidado para alguien, o eres cuidador/a?\n\n1️⃣ Necesito cuidado para alguien\n2️⃣ Soy cuidador/a`
        : `Verified — thanks.\n\nAre you looking for care for someone, or are you a caregiver?\n\n1️⃣ I need care for someone\n2️⃣ I'm a caregiver`,
    otp_resend_too_soon: (lang) => lang === "es"
        ? "Acabo de enviar un código — dale un momento para llegar, y luego revísalo arriba."
        : "I just sent a code — give it a moment to arrive, then check above.",
    otp_resend_new_code: (code, lang) => lang === "es" ? `Nuevo código: ${code}` : `New code: ${code}`,
    otp_fresh_code_after_expiry: (code, lang) => lang === "es"
        ? `Ese código expiró o se agotaron los intentos. Aquí tienes uno nuevo: ${code}`
        : `That code expired or was used up. Here's a fresh one: ${code}`,
    otp_wrong: (attemptsLeft, lang) => {
        const tries = attemptsLeft === 1
            ? (lang === "es" ? "intento" : "try")
            : (lang === "es" ? "intentos" : "tries");
        return lang === "es"
            ? `Ese código no coincide. Te quedan ${attemptsLeft} ${tries}, o responde RESEND para recibir un código nuevo.`
            : `That code doesn't match. ${attemptsLeft} ${tries} left, or reply RESEND to get a new code.`;
    },
    crisis_medical: (lang) => lang === "es"
        ? "🚨 Esto suena a una emergencia. Por favor llama al 911 o ve a la sala de emergencias más cercana de inmediato.\n\nSi necesitas que avise al equipo de cuidado, responde NOTIFICAR."
        : "🚨 This sounds like an emergency. Please call 911 or go to your nearest ER immediately.\n\nIf you need me to notify the care team, reply NOTIFY.",
    crisis_emotional: (lang) => lang === "es"
        ? "Te escucho, y me alegra mucho que me escribieras. 💙\n\nPor favor llama o envía un mensaje al 988 (Línea de Prevención del Suicidio y Crisis) — están disponibles 24/7 y les importas.\n\nYo también estoy aquí. ¿Quieres hablar?"
        : "I hear you, and I'm really glad you reached out. 💙\n\nPlease call or text 988 (Suicide & Crisis Lifeline) — they're available 24/7 and they care.\n\nI'm here too. Do you want to talk?",
    welcome_back: (lang) => lang === "es"
        ? "Bienvenido de nuevo — retomamos donde nos quedamos."
        : "Welcome back — picking up where we left off.",
    session_timeout_onboarding: (lang) => lang === "es"
        ? "Tu sesión expiró. No te preocupes — guardé tu progreso.\n\nResponde RESUME para continuar donde lo dejaste, o START OVER para empezar de nuevo."
        : "Your session timed out. No worries — I saved your progress!\n\nReply RESUME to pick up where you left off, or START OVER to begin fresh.",
    session_timeout_generic: (lang) => lang === "es"
        ? "Tu sesión anterior expiró — solo escríbeme si quieres continuar."
        : "Your previous session timed out — just text me if you'd like to continue.",
    session_timeout_flow: (flowLabel, lang) => lang === "es"
        ? `Parece que nuestra conversación sobre ${flowLabel} expiró. ¿Quieres retomarla? Solo dime qué te gustaría hacer y te ayudo.`
        : `Looks like our ${flowLabel} conversation timed out. Want to pick it back up? Just tell me what you'd like to do next and I'll get you going.`,
    opt_out_confirmation: (lang) => lang === "es"
        ? "Te has dado de baja de los mensajes de Cara. Responde START en cualquier momento para reactivarlos."
        : "You've been unsubscribed from Cara messages. Reply START anytime to reactivate.",
    opt_in_welcome_back: (lang) => lang === "es"
        ? "Bienvenido de nuevo — he reactivado los mensajes de Cara para este número. Responde STOP en cualquier momento para volver a darte de baja."
        : "Welcome back — I've reactivated Cara messages for this number. Reply STOP anytime to opt out again.",
};
// Map of localized "flow labels" used by session_timeout_flow.
const flowLabel = (key, lang) => {
    const labels = {
        job_posting: { en: "posting a job", es: "publicar un trabajo" },
        refund: { en: "requesting a refund", es: "solicitar un reembolso" },
        modify_schedule: { en: "changing your recurring schedule", es: "cambiar tu horario recurrente" },
        client_swap: { en: "swapping a caregiver", es: "cambiar de cuidador/a" },
        healthcare: { en: "a healthcare action", es: "una acción médica" },
        credential: { en: "saving a portal login", es: "guardar un acceso de portal" },
        hire: { en: "hiring a caregiver", es: "contratar un/a cuidador/a" },
        matches: { en: "reviewing caregiver matches", es: "revisar opciones de cuidadores" },
        booking_confirm: { en: "confirming a booking", es: "confirmar una reserva" },
    };
    const entry = labels[key];
    if (!entry)
        return key;
    return lang === "es" ? entry.es : entry.en;
};
exports.flowLabel = flowLabel;
//# sourceMappingURL=language.js.map