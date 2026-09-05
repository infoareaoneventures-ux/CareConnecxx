// The real-world healthcare/browser-automation feature this file used to
// gate (perform_web_action, search_healthcare_provider, and the
// startHealthcareFlow/resumeHealthcareFlow conversation flow) was removed
// entirely 2026-09-05 — the site has no medical-appointment/pharmacy feature
// of any kind. Evia now always deflects these intents; this file's only
// remaining job is producing that deflection message.

export function buildNonMedicalDeflection(intent: string, text: string): string {
  const immediateDanger = /\b(911|emergency|immediate danger|not breathing|unconscious)\b/i.test(text);
  if (immediateDanger) {
    return "Evia coordinates non-medical care and cannot assess or treat an emergency. Call 911 or your local emergency services now.";
  }
  if (intent === "PRESCRIPTION_REFILL" || intent === "NEW_PRESCRIPTION") {
    return "Evia coordinates non-medical care and cannot request or recommend prescriptions. Please contact the pharmacy that fills the prescription or a licensed healthcare provider.";
  }
  if (intent === "FIND_NEARBY_PROVIDER" || intent === "BOOK_DOCTOR_APPOINTMENT") {
    return "Evia coordinates non-medical care and cannot search for providers or book medical appointments at launch. Please contact your health plan or a licensed healthcare provider directly.";
  }
  return "Evia coordinates non-medical care. Please contact a pharmacy or licensed healthcare provider for medical or prescription needs.";
}
