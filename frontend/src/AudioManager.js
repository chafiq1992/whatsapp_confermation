import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

const AudioContextInternal = createContext(null);

export function AudioProvider({ children }) {
  const audioRef = useRef(null);
  const [currentUrl, setCurrentUrl] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRateIndex, setPlaybackRateIndex] = useState(0); // 0:1x, 1:1.5x, 2:2x
  const playbackRates = [1, 1.5, 2];
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);

  // Lazy init single HTMLAudioElement
  if (!audioRef.current && typeof window !== "undefined") {
    audioRef.current = new Audio();
    audioRef.current.preload = "metadata";
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onTime = () => setPositionSec(audio.currentTime || 0);
    const onLoaded = () => setDurationSec(audio.duration || 0);

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("durationchange", onLoaded);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("durationchange", onLoaded);
    };
  }, []);

  const play = async (url) => {
    try {
      const audio = audioRef.current;
      if (!audio) return;
      if (url && url !== currentUrl) {
        setCurrentUrl(url);
        audio.src = url;
      }
      // Apply current rate
      audio.playbackRate = playbackRates[playbackRateIndex] || 1;
      await audio.play();
    } catch (e) {
      // swallow; UI can show failure state if needed
    }
  };

  const pause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    try { audio.pause(); } catch {}
  };

  const stop = () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
      setIsPlaying(false);
    } catch {}
  };

  const toggle = (url) => {
    const audio = audioRef.current;
    if (!audio) return;
    const sameUrl = !!url && url === currentUrl;
    if (sameUrl && !audio.paused) {
      pause();
    } else {
      play(url || currentUrl);
    }
  };

  const cycleSpeed = () => {
    const audio = audioRef.current;
    const next = (playbackRateIndex + 1) % playbackRates.length;
    setPlaybackRateIndex(next);
    if (audio) {
      try { audio.playbackRate = playbackRates[next]; } catch {}
    }
  };

  const seek = (fraction) => {
    const audio = audioRef.current;
    if (!audio || !isFinite(audio.duration) || audio.duration <= 0) return;
    const t = Math.max(0, Math.min(1, Number(fraction))) * audio.duration;
    try { audio.currentTime = t; } catch {}
  };

  const value = useMemo(() => ({
    // state
    currentUrl,
    isPlaying,
    positionSec,
    durationSec,
    playbackRate: playbackRates[playbackRateIndex],
    // controls
    play,
    pause,
    stop,
    toggle,
    cycleSpeed,
    seek,
  }), [currentUrl, isPlaying, positionSec, durationSec, playbackRateIndex]);

  return (
    <AudioContextInternal.Provider value={value}>
      {children}
    </AudioContextInternal.Provider>
  );
}

export function useAudio() {
  const ctx = useContext(AudioContextInternal);
  if (!ctx) return {
    currentUrl: "",
    isPlaying: false,
    positionSec: 0,
    durationSec: 0,
    playbackRate: 1,
    play: () => {},
    pause: () => {},
    stop: () => {},
    toggle: () => {},
    cycleSpeed: () => {},
    seek: () => {},
  };
  return ctx;
}


