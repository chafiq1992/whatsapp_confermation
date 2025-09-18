import { useRef, useState, useEffect } from 'react';

export default function useAudioRecorder(userId, onComplete, options = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const audioChunksRef = useRef([]);
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const analyserRef = useRef(null);
  const dataArrayRef = useRef(null);
  const audioContextRef = useRef(null);
  const canceledRef = useRef(false);

  const maxDuration = options.maxDuration || 120; // seconds

  const drawWaveform = () => {
    if (!analyserRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    analyserRef.current.getByteTimeDomainData(dataArrayRef.current);

    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#4ade80";
    ctx.beginPath();

    const sliceWidth = width / dataArrayRef.current.length;
    let x = 0;

    for (let i = 0; i < dataArrayRef.current.length; i++) {
      const v = dataArrayRef.current[i] / 128.0;
      const y = (v * height) / 2;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    animationRef.current = requestAnimationFrame(drawWaveform);
  };

  useEffect(() => {
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (
        audioContextRef.current &&
        typeof audioContextRef.current.close === "function" &&
        audioContextRef.current.state !== "closed"
      ) {
        audioContextRef.current.close().catch((err) => {
          if (err.name === "AbortError") return;
          console.error("AudioContext close error:", err);
        });
      }
    };
  }, []);

  const setCanvasRef = (ref) => {
    canvasRef.current = ref;
  };

  const startRecording = async () => {
    setRecordingTime(0);
    canceledRef.current = false;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert("Microphone access denied or not available.");
      return;
    }
    streamRef.current = stream;
    // Only webm is widely supported
    const mimeType = "audio/webm";
    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    audioChunksRef.current = chunks;

    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);

    mediaRecorder.onstop = () => {
      clearInterval(timerRef.current);
      cancelAnimationFrame(animationRef.current);
      setRecordingTime(0);
      try {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch {} });
        }
      } catch {}
      // If canceled, do not emit any audio
      if (canceledRef.current) {
        return;
      }
      const blob = new Blob(chunks, { type: mimeType });
      const file = new File([blob], "voice_note.webm", { type: mimeType });
      if (onComplete) onComplete(file, blob, recordingTime);
    };

    audioContextRef.current = new (window.AudioContext ||
      window.webkitAudioContext)();
    const source = audioContextRef.current.createMediaStreamSource(stream);
    analyserRef.current = audioContextRef.current.createAnalyser();
    analyserRef.current.fftSize = 2048;
    dataArrayRef.current = new Uint8Array(analyserRef.current.fftSize);
    source.connect(analyserRef.current);
    drawWaveform();

    mediaRecorder.start();
    setIsRecording(true);
    mediaRecorderRef.current = mediaRecorder;

    timerRef.current = setInterval(() => {
      setRecordingTime((t) => {
        if (t + 1 >= maxDuration) {
          stopRecording();
        }
        return t + 1;
      });
    }, 1000);
  };

  const stopRecording = () => {
    try {
      if (
        mediaRecorderRef.current && 
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("MediaRecorder stop error:", err);
      }
    }
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      }
    } catch {}
    setIsRecording(false);
  };

  const cancelRecording = () => {
    canceledRef.current = true;
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("MediaRecorder stop error:", err);
      }
    }
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      }
    } catch {}
    audioChunksRef.current = [];
    setIsRecording(false);
    setRecordingTime(0);
    cancelAnimationFrame(animationRef.current);
  };

  return {
    isRecording,
    recordingTime,
    startRecording,
    stopRecording,
    cancelRecording,
    setCanvasRef,
    resetTimer: () => setRecordingTime(0),
  };
}
