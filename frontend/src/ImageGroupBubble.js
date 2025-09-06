import React, { useState, useCallback } from "react";

// Copy this helper from your MessageBubble or utils
function getSafeMediaUrl(raw) {
  if (!raw) return "";
  if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
  return "";
}

export default function ImageGroupBubble({ images = [] }) {
  const [zoomIdx, setZoomIdx] = useState(null);

  // Keyboard navigation for zoomed images
  const handleKey = useCallback(
    (e) => {
      if (zoomIdx == null) return;
      if (e.key === "Escape") setZoomIdx(null);
      if (e.key === "ArrowRight") setZoomIdx((i) => (i < images.length - 1 ? i + 1 : i));
      if (e.key === "ArrowLeft") setZoomIdx((i) => (i > 0 ? i - 1 : i));
    },
    [zoomIdx, images.length]
  );

  React.useEffect(() => {
    if (zoomIdx != null) {
      window.addEventListener("keydown", handleKey);
      return () => window.removeEventListener("keydown", handleKey);
    }
  }, [zoomIdx, handleKey]);

  return (
    <>
      <div className={`grid ${images.length > 2 ? "grid-cols-2" : "grid-cols-1"} md:grid-cols-3 gap-2 max-w-[420px] max-h-[240px] overflow-x-auto overflow-y-auto rounded-xl p-2 bg-slate-800`}>
        {images.map((img, idx) => (
          <div key={idx} className="relative flex flex-col items-center">
            <img
              src={getSafeMediaUrl(img.url || img.message)}
              alt={`Image ${idx + 1}`}
              className="rounded-lg object-cover h-[90px] w-[90px] cursor-pointer"
              onClick={() => setZoomIdx(idx)}
              onError={e => (e.target.src = "/broken-image.png")}
            />
            {(img.caption || img.price) && (
              <div className="absolute bottom-1 left-1 right-1 text-xs text-gray-200 bg-black bg-opacity-60 px-1 py-0.5 rounded">
                {img.caption || img.price}
              </div>
            )}
          </div>
        ))}
      </div>
      {zoomIdx != null && (
        <div
          className="fixed inset-0 z-50 flex justify-center items-center bg-black bg-opacity-70"
          onClick={() => setZoomIdx(null)}
        >
          <div className="relative" onClick={e => e.stopPropagation()}>
            <img
              src={getSafeMediaUrl(images[zoomIdx].url || images[zoomIdx].message)}
              alt="zoomed"
              className="max-w-[90vw] max-h-[90vh] rounded-2xl shadow-lg"
            />
            {/* Show image index (1 of N) */}
            <div className="absolute bottom-2 left-2 text-xs text-white bg-black bg-opacity-40 rounded px-2 py-0.5">
              {zoomIdx + 1} / {images.length}
            </div>
            <button
              onClick={() => setZoomIdx(null)}
              className="absolute -top-4 -right-4 text-white text-xl bg-black bg-opacity-60 rounded-full px-3 py-1"
            >
              ✕
            </button>
            {/* Prev/Next arrows for keyboard/mouse */}
            {zoomIdx > 0 && (
              <button
                onClick={() => setZoomIdx(zoomIdx - 1)}
                className="absolute left-1 top-1/2 -translate-y-1/2 bg-black bg-opacity-30 rounded-full p-2 text-white text-2xl"
                aria-label="Previous"
              >
                ‹
              </button>
            )}
            {zoomIdx < images.length - 1 && (
              <button
                onClick={() => setZoomIdx(zoomIdx + 1)}
                className="absolute right-1 top-1/2 -translate-y-1/2 bg-black bg-opacity-30 rounded-full p-2 text-white text-2xl"
                aria-label="Next"
              >
                ›
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
