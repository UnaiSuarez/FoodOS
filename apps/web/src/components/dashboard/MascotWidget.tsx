"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { getMascot, useFoodOS, useFoodOSUI, getAdherenceStreak, getToday } from "@/lib/state";
import type { MascotState } from "@/lib/state";

const LAST_VISIT_KEY = "foodos-mascot-last-visit";

export function MascotWidget() {
  const { state, triggerMascot } = useFoodOS();
  const { mascotMessage, mascotState } = useFoodOSUI();
  const mascot = getMascot(state.mascotId);
  const [bubble, setBubble] = useState(false);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout>>();
  const inactivityTimer = useRef<ReturnType<typeof setTimeout>>();
  const prevMsgRef = useRef(mascotMessage);

  // First visit of day → wave
  useEffect(() => {
    const today = getToday(state);
    const last = localStorage.getItem(LAST_VISIT_KEY);
    if (last !== today) {
      localStorage.setItem(LAST_VISIT_KEY, today);
      setTimeout(() => triggerMascot("wave", `¡Buenos días! ${mascot.tagline}.`), 800);
    }
  }, [mascot.tagline, state.debugDate, triggerMascot]);

  // Streak celebration: ≥7 days → streak anim once per day
  useEffect(() => {
    const streak = getAdherenceStreak(state);
    if (streak >= 7) {
      const key = `foodos-streak-celebrated-${getToday(state)}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        setTimeout(() => triggerMascot("streak", `¡${streak} días consecutivos cumpliendo macros! 🔥`), 1200);
      }
    }
  }, [state, triggerMascot]);

  // Show speech bubble when message changes
  useEffect(() => {
    if (mascotMessage !== prevMsgRef.current) {
      prevMsgRef.current = mascotMessage;
      setBubble(true);
      clearTimeout(bubbleTimer.current);
      bubbleTimer.current = setTimeout(() => setBubble(false), 4500);
    }
  }, [mascotMessage]);

  // Inactivity → sleep after 5 min
  useEffect(() => {
    function resetTimer() {
      clearTimeout(inactivityTimer.current);
      if (mascotState === "sleep") triggerMascot("idle");
      inactivityTimer.current = setTimeout(() => triggerMascot("sleep"), 5 * 60 * 1000);
    }
    window.addEventListener("mousemove", resetTimer);
    window.addEventListener("keydown", resetTimer);
    resetTimer();
    return () => {
      window.removeEventListener("mousemove", resetTimer);
      window.removeEventListener("keydown", resetTimer);
      clearTimeout(inactivityTimer.current);
    };
  }, [mascotState, triggerMascot]);

  return (
    <div className="mascot-widget">
      {bubble && mascotMessage && (
        <div
          className="mascot-bubble"
          style={{ borderColor: mascot.color + "60", background: mascot.color + "15", color: mascot.color }}
        >
          {mascotMessage}
        </div>
      )}
      <button
        className={`mascot-sprite mascot-${mascotState}`}
        onClick={() => triggerMascot("wave")}
        title={`${mascot.name} — clic para saludar`}
        aria-label={`Mascota ${mascot.name}`}
      >
        <Image
          src={mascot.image}
          alt={mascot.name}
          width={64}
          height={64}
          style={{ width: 64, height: 64, objectFit: "contain" }}
        />
        {mascotState === "thinking" && (
          <span className="mascot-dots" aria-hidden="true">···</span>
        )}
        {mascotState === "sleep" && (
          <span className="mascot-zzz" aria-hidden="true">z z z</span>
        )}
        {(mascotState === "celebrate" || mascotState === "streak") && (
          <span className="mascot-sparkles" aria-hidden="true">✨</span>
        )}
      </button>
    </div>
  );
}

// Hook to expose triggerMascot for use in other components
export { type MascotState };
