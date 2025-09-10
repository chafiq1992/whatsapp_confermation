import React from "react";
import { useAudio } from "./AudioManager";

export default function GlobalAudioBar() {
  const { currentUrl, isPlaying, positionSec, durationSec, playbackRate, toggle, stop, cycleSpeed, seek } = useAudio();
  if (!currentUrl) return null;

  const pct = durationSec > 0 ? Math.min(100, Math.max(0, (positionSec / durationSec) * 100)) : 0;
  const fmt = (s) => {
    if (!isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div className="fixed bottom-2 left-1/2 -translate-x-1/2 z-[999]">
      <div className="flex items-center gap-2 px-3 py-2 rounded-full shadow-xl border border-gray-700 bg-gray-900/95 backdrop-blur">
        <button
          className="w-8 h-8 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center"
          onClick={() => toggle()}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16">
              <rect x="3" y="2" width="3" height="12" />
              <rect x="10" y="2" width="3" height="12" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          )}
        </button>
        <button
          className="px-2 h-8 rounded text-xs bg-gray-700 hover:bg-gray-600"
          onClick={cycleSpeed}
          title="Playback speed"
        >
          {`${playbackRate}x`}
        </button>
        <div className="flex items-center gap-2 w-[280px] select-none">
          <span className="text-[11px] opacity-70 w-10 text-right">{fmt(positionSec)}</span>
          <input
            className="w-full"
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round(pct * 10)}
            onChange={(e) => { const f = (Number(e.target.value) / 1000); seek(f); }}
          />
          <span className="text-[11px] opacity-70 w-10">{fmt(durationSec)}</span>
        </div>
        <button
          className="px-2 h-8 rounded text-xs bg-gray-700 hover:bg-gray-600"
          onClick={stop}
          title="Stop"
        >
          Stop
        </button>
      </div>
    </div>
  );
}


