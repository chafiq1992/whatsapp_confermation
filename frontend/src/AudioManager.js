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

  // Simple IndexedDB cache for audio blobs (one DB, one store)
  const dbRef = useRef(null);
  useEffect(() => {
    if (!('indexedDB' in window)) return;
    const openReq = indexedDB.open('media-cache', 1);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
    };
    openReq.onsuccess = () => { dbRef.current = openReq.result; };
    openReq.onerror = () => { dbRef.current = null; };
  }, []);

  const cacheGet = (key) => new Promise((resolve) => {
    try {
      const db = dbRef.current; if (!db) return resolve(null);
      const tx = db.transaction('audio', 'readonly');
      const store = tx.objectStore('audio');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  const cachePut = (key, val) => new Promise((resolve) => {
    try {
      const db = dbRef.current; if (!db) return resolve(false);
      const tx = db.transaction('audio', 'readwrite');
      const store = tx.objectStore('audio');
      const req = store.put(val, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch { resolve(false); }
  });

  const play = async (url) => {
    try {
      const audio = audioRef.current;
      if (!audio) return;
      if (url && url !== currentUrl) {
        setCurrentUrl(url);
        // Try cache first
        const cached = await cacheGet(url);
        if (cached instanceof Blob) {
          audio.src = URL.createObjectURL(cached);
        } else {
          audio.src = url;
          // Warm cache in background (ignore SW; backend bypasses Range)
          try {
            const res = await fetch(url, { method: 'GET' });
            if (res.ok) {
              const blob = await res.blob();
              cachePut(url, blob);
            }
          } catch {}
        }
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


