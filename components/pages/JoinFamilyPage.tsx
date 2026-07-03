import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Heart, Phone, CheckCircle, AlertCircle, Loader } from 'lucide-react';

type PageState = "loading" | "ready" | "joining" | "joined" | "error" | "invalid";

function decodeJoinToken(token: string): { primaryPhone: string; seniorName: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const body = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(body.padEnd(body.length + ((4 - body.length % 4) % 4), "="));
    const parsed = JSON.parse(decoded);
    if (parsed?.task !== "family_join" || typeof parsed?.phone !== "string") return null;
    return {
      primaryPhone: parsed.phone,
      seniorName: typeof parsed.seniorName === "string" && parsed.seniorName.trim()
        ? parsed.seniorName.trim()
        : "your loved one",
    };
  } catch {
    return null;
  }
}

export default function JoinFamilyPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("t");

  const [state,       setState]       = useState<PageState>("loading");
  const [seniorName,  setSeniorName]  = useState("your loved one");
  const [phone,       setPhone]       = useState("");
  const [phoneError,  setPhoneError]  = useState("");

  useEffect(() => {
    if (!token) { setState("invalid"); return; }
    const data = decodeJoinToken(token);
    if (!data?.primaryPhone || !data?.seniorName) { setState("invalid"); return; }
    setSeniorName(data.seniorName);
    setState("ready");
  }, [token]);

  function formatPhone(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return `+${digits}`;
  }

  async function handleJoin() {
    const formatted = formatPhone(phone);
    if (formatted.length < 12) {
      setPhoneError("Please enter a valid US phone number.");
      return;
    }
    setPhoneError("");
    setState("joining");

    try {
      const data = decodeJoinToken(token!);
      if (!data) throw new Error("invalid token");

      // Call Firebase Function to add the member
      const { getFunctions, httpsCallable } = await import("firebase/functions");
      const fns  = getFunctions();
      const join = httpsCallable(fns, "v1-addFamilyGroupMember");
      await join({ token, memberPhone: formatted });

      setState("joined");
    } catch (err) {
      console.error("JoinFamilyPage join error:", err);
      setState("error");
    }
  }

  const LINQ_NUMBER = import.meta.env.VITE_LINQ_PHONE_NUMBER ?? "+18005550199";
  const smsLink = `sms:${LINQ_NUMBER}?body=${encodeURIComponent("Hey Evia!")}`;

  if (state === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper-50">
        <Loader className="w-8 h-8 animate-spin text-ink-400" />
      </div>
    );
  }

  if (state === "invalid") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper-50 p-6">
        <div className="text-center max-w-sm">
          <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h1 className="font-display text-xl font-semibold text-ink-900 tracking-[-0.02em] mb-2">Invalid invitation</h1>
          <p className="text-ink-600 text-sm">This link may have expired or is no longer valid. Ask the primary account holder to resend the invite.</p>
        </div>
      </div>
    );
  }

  if (state === "joined") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper-50 p-6">
        <div className="text-center max-w-sm">
          <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-4" />
          <h1 className="font-display text-xl font-semibold text-ink-900 tracking-[-0.02em] mb-2">You're in! 💙</h1>
          <p className="text-ink-600 mb-6">
            You've joined {seniorName}'s care group on Evia. You'll now receive care updates and can message Evia directly.
          </p>
          <a
            href={smsLink}
            className="inline-flex items-center justify-center btn-depth-primary rounded-full px-8 py-3.5 font-semibold text-[15px] min-h-[44px]"
          >
            Say hi to Evia
          </a>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-indigo-50 to-white p-6">
        <div className="text-center max-w-sm">
          <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h1>
          <p className="text-slate-500 text-sm mb-4">We couldn't add you right now. Please try again or contact support.</p>
          <button
            onClick={() => setState("ready")}
            className="bg-indigo-600 text-white px-5 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-indigo-50 to-white p-6">
      <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 max-w-sm w-full text-center">
        <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-5">
          <Heart className="w-8 h-8 text-indigo-600" />
        </div>

        <h1 className="text-xl font-bold text-slate-800 mb-2">
          Join {seniorName}'s care group
        </h1>
        <p className="text-slate-500 text-sm mb-6">
          Get care updates and message Evia — the care coordinator helping coordinate care for {seniorName}.
        </p>

        <div className="text-left mb-4">
          <label className="block text-xs font-medium text-slate-600 mb-1">Your phone number</label>
          <div className="relative">
            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 (555) 000-1234"
              className="w-full pl-9 pr-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          {phoneError && <p className="text-red-500 text-xs mt-1">{phoneError}</p>}
        </div>

        <button
          onClick={handleJoin}
          disabled={state === "joining"}
          className="w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold text-sm hover:bg-indigo-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {state === "joining" && <Loader className="w-4 h-4 animate-spin" />}
          Join care group
        </button>

        <p className="text-xs text-slate-400 mt-4">
          By joining, you agree to receive care updates via iMessage from Evia. Reply STOP anytime to unsubscribe.
        </p>
      </div>
    </div>
  );
}
