import React, { useEffect, useState } from 'react';

// Sisa waktu giliran. Server mengirim sisa milidetik saat itu; batas waktunya dihitung dari jam lokal
// supaya selisih jam HP dan server tidak berpengaruh.
function useDeadline(clock) {
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!clock) return undefined;
    setDeadline(Date.now() + clock.remainingMs);
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [clock?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return { deadline, now };
}

export const URGENT_SECONDS = 5;

// Bar + angka detik di panel giliran
export default function TurnTimer({ clock, isMine }) {
  const { deadline, now } = useDeadline(clock);
  if (!clock || !deadline) return null;

  const leftMs = Math.max(0, deadline - now);
  // Tahan di 1 detik sampai sistem benar-benar menjalankan giliran
  const seconds = Math.max(1, Math.ceil(leftMs / 1000));
  const urgent = seconds <= URGENT_SECONDS;

  return (
    <div className={`turn-timer ${urgent ? 'is-urgent' : ''}`} role="timer" aria-label={`Sisa waktu giliran ${seconds} detik`}>
      <span className="turn-timer__track" aria-hidden="true">
        <span className="turn-timer__bar" style={{ transform: `scaleX(${leftMs / clock.totalMs})` }} />
      </span>
      <span className="turn-timer__text">
        {urgent && isMine ? `${seconds} dtk lagi dijalankan otomatis` : `${seconds} dtk`}
      </span>
    </div>
  );
}

// Bar tipis di kartu HUD pemain yang sedang jalan. Pakai animasi CSS (tanpa re-render tiap detik)
// karena papan di-memo; nilai awal dikunci sekali per giliran.
export function HudTimer({ clock }) {
  const [start] = useState(() => ({
    fraction: Math.min(1, clock.remainingMs / clock.totalMs),
    durationMs: clock.remainingMs,
    urgentDelayMs: Math.max(0, clock.remainingMs - URGENT_SECONDS * 1000)
  }));
  return (
    <span
      className="hud-timer"
      aria-hidden="true"
      style={{
        '--timer-start': start.fraction,
        '--timer-duration': `${start.durationMs}ms`,
        '--timer-urgent-delay': `${start.urgentDelayMs}ms`
      }}
    />
  );
}
