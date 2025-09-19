import React, { useRef, useEffect, useState, useMemo } from "react";
import { useAudio } from "./AudioManager";
import { Clock3, Check, CheckCheck, XCircle, Reply, Forward } from "lucide-react"; // 14 KB gzipped
/* eslint-env es2020 */

/* prettier, pixel-perfect WhatsApp ticks */
const ICONS = {
  sending:   <Clock3     size={15} className="text-gray-400" />,
  sent:      <Check      size={15} className="text-gray-400" />,
  delivered: <CheckCheck size={15} className="text-gray-400" />,
  read:      <CheckCheck size={15} className="text-blue-500" />,
  failed:    <XCircle    size={15} className="text-red-500" />,
};

// Media URL utility: use only absolute or blob/data URLs; drop local fallback
export function getSafeMediaUrl(raw) {
  if (!raw) return "";
  if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
  return "";
}

// Message status ticks renderer
function renderTick(msg, self) {
  if (!self) return null;
  const status = msg.status || "sent";   // fall-back if backend is late
  return ICONS[status] || null;
}

// Format timestamp utility
function formatTime(ts) {
  if (!ts) return "";
  try {
    const date = new Date(ts);
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Africa/Casablanca',
    }).format(date);
  } catch {
    const s = String(ts);
    return s.length > 15 ? s.slice(11, 16) : s;
  }
}

export default function MessageBubble({ msg, self, catalogProducts = {}, highlightQuery = "", onForward, quotedMessage = null, onReply, onReact }) {
  const API_BASE = process.env.REACT_APP_API_BASE || "";
  const [showReactPicker, setShowReactPicker] = useState(false);
  // Helpers to extract and classify URLs inside text messages
  const extractUrls = (text) => {
    try {
      const pattern = /https?:\/\/[\w.-]+(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/gi;
      return String(text || "").match(pattern) || [];
    } catch { return []; }
  };
  const isImageUrl = (u) => /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(u) || /cdn\.shopify\.com\//i.test(u);
  // Enhanced order data parsing with better error handling
  const getOrderData = () => {
    if (msg.type !== "order") return null;
    
    try {
      if (typeof msg.message === "object" && msg.message !== null) {
        return msg.message;
      }
      if (typeof msg.message === "string") {
        const parsed = JSON.parse(msg.message);
        return parsed;
      }
    } catch (error) {
      console.warn("Failed to parse order message:", error);
    }
    return null;
  };

  const order = getOrderData();
  const isOrder = msg.type === "order" && order;

  // Compute media URL, prefer msg.url, fallback to string msg.message if it looks like a URL
  const primaryUrl = useMemo(() => {
    const u1 = getSafeMediaUrl(msg?.url);
    if (u1) return u1;
    if (typeof msg?.message === 'string') {
      const u2 = getSafeMediaUrl(msg.message);
      if (u2) return u2;
    }
    return "";
  }, [msg?.url, msg?.message]);
  const isAudio = msg.type === "audio";
  const mediaUrl = primaryUrl;
  // Use backend proxy for audio to avoid CORS issues when drawing waveform
  const effectiveAudioUrl = isAudio
    ? (primaryUrl && /^https?:\/\//i.test(primaryUrl)
        ? `${API_BASE}/proxy-audio?url=${encodeURIComponent(primaryUrl)}`
        : primaryUrl)
    : null;

  // Effective audio URL used for playback
  const audioUrl = useMemo(() => (isAudio ? (effectiveAudioUrl || primaryUrl) : ""), [isAudio, effectiveAudioUrl, primaryUrl]);

  // Enhanced media type detection
  const isGroupedImages = Array.isArray(msg.message) &&
    msg.message.length > 0 &&
    msg.message.every(item => item && (item.type === "image" || typeof item.message === "string"));

  const isImage = msg.type === "image" && !isGroupedImages;
  const isVideo = msg.type === "video";
  const isCatalogItem = msg.type === "catalog_item" || msg.type === "interactive_product";
  const isCatalogSet = msg.type === "catalog_set";
  const isText = msg.type === "text" || (!isImage && !isAudio && !isVideo && !isOrder && !isGroupedImages);
  const [linkPreview, setLinkPreview] = useState(null);
  const [linkPreviewError, setLinkPreviewError] = useState(false);
  // Avoid repeated row-resize notifications on re-mounts by remembering loaded images
  const singleImageLoadedRef = React.useRef(false);
  const loadedSrcsRef = React.useRef(new Set());

  // In-memory link preview cache to avoid refetching on remounts/rerenders
  // TTL keeps previews reasonably fresh while preventing flicker
  const LINK_PREVIEW_TTL_MS = 30 * 60 * 1000; // 30 minutes
  const previewCacheRef = React.useRef(globalThis.__linkPreviewCache || (globalThis.__linkPreviewCache = new Map()));
  const inFlightRef = React.useRef(globalThis.__linkPreviewInFlight || (globalThis.__linkPreviewInFlight = new Map()));

  const firstPageUrl = useMemo(() => {
    if (!isText) return "";
    const urls = extractUrls(msg?.message);
    if (!urls.length) return "";
    const u = urls.find(u => !isImageUrl(u)) || "";
    if (!u) return "";
    try {
      const nu = new URL(u);
      // normalize to reduce cache misses
      nu.hash = "";
      return nu.toString();
    } catch {
      return u;
    }
  }, [isText, msg?.message]);

  useEffect(() => {
    if (!firstPageUrl) return;
    let aborted = false;

    // Serve from cache if fresh
    try {
      const cached = previewCacheRef.current.get(firstPageUrl);
      if (cached && (Date.now() - cached.ts) < LINK_PREVIEW_TTL_MS) {
        setLinkPreviewError(false);
        setLinkPreview(cached.data);
        return;
      }
    } catch {}

    // Attach to in-flight promise if already fetching
    const inFlight = inFlightRef.current.get(firstPageUrl);
    if (inFlight) {
      inFlight.then((data) => { if (!aborted) { setLinkPreviewError(false); setLinkPreview(data); } })
              .catch(() => { if (!aborted) setLinkPreviewError(true); });
      return () => { aborted = true; };
    }

    setLinkPreviewError(false);
    const p = (async () => {
      const res = await fetch(`${API_BASE}/link-preview?url=${encodeURIComponent(firstPageUrl)}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      try { previewCacheRef.current.set(firstPageUrl, { ts: Date.now(), data }); } catch {}
      return data;
    })();

    inFlightRef.current.set(firstPageUrl, p);
    p.then((data) => {
      if (!aborted) {
        setLinkPreview(data);
        // Trigger a re-measure so the virtual list accounts for newly added preview
        try { window.requestAnimationFrame(() => notifyResize()); } catch { notifyResize(); }
      }
    }).catch(() => {
      if (!aborted) setLinkPreviewError(true);
    }).finally(() => {
      // Clear in-flight regardless of outcome to allow future retries after TTL
      try { inFlightRef.current.delete(firstPageUrl); } catch {}
    });

    return () => { aborted = true; };
  }, [firstPageUrl, API_BASE]);

  // Audio player state and refs (bar-based waveform)
  const waveformRef = useRef(null);
  const { currentUrl, isPlaying, positionSec, durationSec, toggle: toggleGlobalAudio, cycleSpeed: cycleGlobalSpeed, playbackRate: globalRate, seek: seekGlobal } = useAudio();

  const isThisActive = !!audioUrl && currentUrl === audioUrl;
  const progress = isThisActive && durationSec > 0 ? Math.max(0, Math.min(1, positionSec / durationSec)) : 0;

  // Waveform bars (prefer real server-provided waveform; fallback to synthetic)
  const parseWaveform = (w) => {
    try {
      if (!w) return null;
      const arr = Array.isArray(w) ? w : JSON.parse(w);
      const nums = arr.map((n) => Math.max(0, Math.min(100, Number(n) || 0)));
      const count = 56;
      if (nums.length === count) return nums;
      if (nums.length > count) return nums.slice(0, count);
      // pad
      return nums.concat(Array.from({ length: count - nums.length }, () => 0));
    } catch { return null; }
  };
  const realWave = useMemo(() => parseWaveform(msg?.waveform), [msg?.waveform]);
  const synthBars = useMemo(() => {
    const s = String(msg?.wa_message_id || msg?.id || audioUrl || primaryUrl || "");
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    let x = h >>> 0;
    const out = [];
    for (let i = 0; i < 56; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; const v = (x>>>0)/4294967295; out.push(Math.floor(20 + v * 60)); }
    return out.map(v => Math.max(8, Math.min(46, Math.floor(8 + (v/100)*38))));
  }, [msg?.wa_message_id, msg?.id, audioUrl, primaryUrl]);
  const bars = useMemo(() => {
    if (realWave && realWave.length) {
      // map 0..100 -> 8..46 px
      return realWave.map((v) => Math.max(8, Math.min(46, Math.floor(8 + (v / 100) * 38))));
    }
    return synthBars;
  }, [realWave, synthBars]);

  // Video player state and refs
  const [videoError, setVideoError] = useState(false);

  // Enhanced image error handling
  const handleImageError = (e, fallbackSrc = "/broken-image.png") => {
    if (e.target.src === fallbackSrc) return; // Prevent infinite loops
    e.target.onerror = null;
    e.target.src = fallbackSrc;
    e.target.alt = "Image failed to load";
  };
  const notifyResize = () => {
    try { window.dispatchEvent(new CustomEvent('row-resize')); } catch {}
  };

  // Click-to-seek on waveform
  const handleSeekClick = (e) => {
    if (!audioUrl) return;
    try {
      const rect = e.currentTarget.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      seekGlobal(fraction);
    } catch {}
  };

  // Toggle playback speed like WhatsApp Business (1x -> 1.5x -> 2x -> 1x)
  const handleToggleSpeed = () => {
    try { cycleGlobalSpeed(); } catch {}
  };

  // Audio play/pause handler with error handling
  const handlePlayPause = () => {
    try {
      if (!audioUrl) return;
      toggleGlobalAudio(audioUrl);
    } catch {}
  };

  // Enhanced single image renderer
  const renderSingleImage = (src, alt, caption) => (
    <div className="flex flex-col">
      <img
        src={src}
        alt={alt}
        className="rounded-xl mb-1 w-[250px] h-auto object-cover cursor-pointer hover:opacity-90 transition-opacity bg-gray-100"
        style={{ aspectRatio: '4 / 3' }}
        onError={(e) => handleImageError(e)}
        onLoad={() => { if (!singleImageLoadedRef.current) { singleImageLoadedRef.current = true; notifyResize(); } }}
        loading="lazy"
        onClick={() => window.open(src, '_blank')}
      />
      {caption && (
        <div className="text-xs mt-1 text-gray-700 bg-black/5 px-2 py-1 rounded">
          {caption}
        </div>
      )}
    </div>
  );

  // Enhanced grouped images renderer
  const renderGroupedImages = () => (
    <div className={`grid ${msg.message.length > 2 ? "grid-cols-2" : "grid-cols-1"} gap-2`}>
      {msg.message.map((img, idx) => {
        const raw = getSafeMediaUrl(img.url || img.message);
        const proxied = raw && /^https?:\/\//i.test(raw) ? `${API_BASE}/proxy-image?url=${encodeURIComponent(raw)}` : raw;
        const imgCaption = img.caption || img.price;
        
        return (
          <div key={idx} className="flex flex-col items-center">
            <img
              src={proxied}
              alt={`Image ${idx + 1}`}
              className="rounded-xl mb-1 w-[160px] h-[120px] object-cover cursor-pointer hover:opacity-90 transition-opacity bg-gray-100"
              onError={(e) => handleImageError(e)}
              onLoad={() => { const key = proxied || ''; if (!loadedSrcsRef.current.has(key)) { loadedSrcsRef.current.add(key); notifyResize(); } }}
              loading="lazy"
              onClick={() => window.open(raw || proxied, '_blank')}
            />
            {imgCaption && (
              <div className="text-xs mt-1 text-gray-700 bg-black/5 px-2 py-1 rounded">
                {imgCaption}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // Enhanced audio renderer
  const renderAudio = () => (
    <div className="flex flex-col">
      <div className="flex items-center mb-1">
        <button
          onClick={handlePlayPause}
          disabled={!audioUrl}
          className={`mr-2 rounded-full w-8 h-8 flex items-center justify-center focus:outline-none transition-colors ${
            !audioUrl
              ? 'bg-red-500 cursor-not-allowed'
              : 'bg-gray-600 hover:bg-gray-500'
          }`}
          aria-label={isThisActive && isPlaying ? "Pause audio" : "Play audio"}
        >
          {!audioUrl ? (
            <span className="text-xs">✖</span>
          ) : (isThisActive && isPlaying) ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16">
              <rect x="3" y="2" width="3" height="12" />
              <rect x="10" y="2" width="3" height="12" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          )}
        </button>
        {!!audioUrl && (
          <button
            onClick={handleToggleSpeed}
            className="mr-2 px-2 h-8 rounded text-xs bg-gray-600 hover:bg-gray-500"
            title="Playback speed"
          >
            {`${globalRate || 1}x`}
          </button>
        )}
        <div
          ref={waveformRef}
          onClick={handleSeekClick}
          className="relative flex-1 min-w-[180px] max-w-[320px] h-[48px] mb-1 cursor-pointer select-none"
          title="Seek"
        >
          <div className="absolute inset-0 flex items-end gap-[1px] px-1">
            {bars.map((h, i) => {
              const passed = i < Math.floor(progress * bars.length);
              return (
                <div
                  key={i}
                  className={`${passed ? 'bg-[#219ebc]' : 'bg-[#8ecae6]'} w-[2px] rounded-sm`}
                  style={{ height: `${Math.max(8, Math.min(46, h))}px` }}
                />
              );
            })}
          </div>
        </div>
      </div>
      
      {msg.transcription && (
        <div className="mt-1 text-xs italic text-gray-300 bg-gray-800 bg-opacity-70 p-2 rounded backdrop-blur-sm">
          <span>📝 {msg.transcription}</span>
        </div>
      )}
    </div>
  );

  // Enhanced video renderer
  const renderVideo = () => (
    videoError ? (
      <div className="text-xs text-red-300 italic">Video file missing or failed to load</div>
    ) : (
      <video
        controls
        src={mediaUrl ? `${API_BASE}/proxy-media?url=${encodeURIComponent(mediaUrl)}` : ""}
        className="mb-1 max-w-[250px] rounded-xl bg-gray-100"
        onError={() => setVideoError(true)}
        preload="metadata"
      >
        Your browser does not support the video element.
      </video>
    )
  );

  // Enhanced order renderer
  const renderOrder = () => (
    <div className="font-sans">
      <div className="font-bold mb-3 text-yellow-800 flex items-center">
        <span className="mr-2">🛒</span>
        Order Received
      </div>
      
      <div className="space-y-2">
        <div className="text-sm">
          <span className="font-semibold text-yellow-700">Catalog ID:</span> {order.catalog_id}
        </div>
        
        {order.product_items && order.product_items.length > 0 && (
          <div className="mt-3">
            <div className="font-semibold text-blue-700 text-base mb-3">
              Products ({order.product_items.length}):
            </div>
            
            <ul className="space-y-3">
              {order.product_items.map((item, i) => {
                const product = catalogProducts[String(item.product_retailer_id)] || {};
                const hasProductInfo = product.name || product.image;
                // Try to infer size/color from common WhatsApp payload shapes
                const customizations = item.customizations || item.variations || item.attributes || [];
                // Broad scan for size/color on the item object as well
                const lowerKeys = Object.entries(item || {}).reduce((acc, [k, v]) => {
                  acc[k.toLowerCase()] = v;
                  return acc;
                }, {});
                const getFromArray = (arr, key) => {
                  try {
                    const found = (arr || []).find(
                      (c) =>
                        (c?.name || c?.type || c?.key || "").toString().toLowerCase() === key
                        || (c?.title || "").toString().toLowerCase() === key
                    );
                    return (found?.value || found?.option || found?.selection || found?.text || "").toString();
                  } catch {
                    return "";
                  }
                };
                const sizeVal = lowerKeys.size || lowerKeys.variant_size || getFromArray(customizations, "size");
                const colorVal = lowerKeys.color || lowerKeys.variant_color || getFromArray(customizations, "color");
                // Extra: parse '(Size: X, Color: Y)' from a name/description if present
                const tryParseFromText = (txt) => {
                  if (!txt || typeof txt !== 'string') return {};
                  const mSize = txt.match(/size\s*[:\-]\s*([A-Za-z0-9]+)/i);
                  const mColor = txt.match(/color|couleur\s*[:\-]\s*([\w\s]+)/i);
                  return {
                    size: mSize?.[1] || "",
                    color: mColor?.[1] || "",
                  };
                };
                const parsedFromText = tryParseFromText(product.name || item.name || "");
                const finalSize = sizeVal || parsedFromText.size;
                const finalColor = colorVal || parsedFromText.color;

                // Image fallbacks from order payload
                const orderImage = item.product_image_url || item.image_url || item.image?.url || item.product?.image?.url;
                const effectiveImage = orderImage || product.image || "";
                
                return (
                  <li
                    key={i}
                    className="flex items-center rounded-xl bg-white/95 border border-blue-200 shadow-sm p-3 gap-3 transition-all hover:shadow-md hover:bg-blue-50/50"
                  >
                    <div className="flex-shrink-0">
                      {effectiveImage ? (
                        <img
                          src={effectiveImage}
                          alt={product.name || `Product ${item.product_retailer_id}`}
                          className="w-14 h-14 object-cover rounded-lg border border-blue-200 shadow-sm bg-gray-50"
                          onError={(e) => handleImageError(e, '/placeholder-product.png')}
                        />
                      ) : (
                        <div className="w-14 h-14 rounded-lg bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center text-blue-500 text-xl border border-blue-200 shadow-sm">
                          🛒
                        </div>
                      )}
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-gray-800 text-base leading-tight mb-1 truncate">
                        {product.name || (
                          <span className="text-sm text-gray-500 font-normal">
                            Product ID: {item.product_retailer_id}
                          </span>
                        )}
                      </div>
                      
                      <div className="flex flex-wrap gap-2 text-sm text-gray-600">
                        <span className="flex items-center">
                          <span className="font-medium text-blue-700">Qty:</span>
                          <span className="ml-1 font-semibold">{item.quantity}</span>
                        </span>
                        
                        <span className="text-gray-400">|</span>
                        
                        <span className="flex items-center">
                          <span className="font-medium text-blue-700">Price:</span>
                          <span className="ml-1 font-semibold">
                            {item.item_price} {item.currency || "MAD"}
                          </span>
                        </span>
                        {finalSize && (
                          <>
                            <span className="text-gray-400">|</span>
                            <span className="flex items-center">
                              <span className="font-medium text-blue-700">Size:</span>
                              <span className="ml-1 font-semibold">{finalSize}</span>
                            </span>
                          </>
                        )}
                        {finalColor && (
                          <>
                            <span className="text-gray-400">|</span>
                            <span className="flex items-center">
                              <span className="font-medium text-blue-700">Color:</span>
                              <span className="ml-1 font-semibold">{finalColor}</span>
                            </span>
                          </>
                        )}
                      </div>
                      
                      {product.price && product.price !== item.item_price && (
                        <div className="mt-2">
                          <span className="inline-block text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full border border-blue-100">
                            <span className="font-medium">Catalog Price:</span> {product.price} {item.currency || "MAD"}
                          </span>
                        </div>
                      )}
                      <div className="mt-2">
                        <button
                          type="button"
                          className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded"
                          onClick={() => {
                            try {
                              window.dispatchEvent(
                                new CustomEvent("add-to-order", {
                                  detail: {
                                    variantId: String(item.product_retailer_id),
                                    quantity: Number(item.quantity) || 1,
                                  },
                                })
                              );
                            } catch {}
                          }}
                          title="Add this item to the Shopify order panel"
                        >
                          Add to Order
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        
        {order.total && (
          <div className="mt-3 pt-2 border-t border-yellow-200">
            <div className="text-right font-semibold text-yellow-800">
              Total: {order.total} {order.currency || "MAD"}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // Simple highlighter for text content
  const highlightText = (text, query) => {
    try {
      const q = String(query || "").trim();
      if (!q) return text;
      const parts = String(text || "").split(new RegExp(`(${q.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")})`, 'ig'));
      return parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase()
          ? <mark key={i} className="bg-yellow-300 text-black px-0.5 rounded">{part}</mark>
          : <React.Fragment key={i}>{part}</React.Fragment>
      );
    } catch {
      return text;
    }
  };

  // Main component render
  if (isOrder) {
    return (
      <div className={`relative flex ${self ? "justify-end" : "justify-start"} px-3 my-2`}>
        <div className="max-w-[85%] px-4 py-3 rounded-2xl shadow-lg bg-gradient-to-br from-yellow-50 to-orange-50 border border-yellow-200">
          {renderOrder()}
          <div className="flex items-center justify-end mt-3 pt-2 border-t border-yellow-200">
            <span className="text-xs text-gray-600">{formatTime(msg.timestamp)}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative flex ${self ? "justify-end" : "justify-start"} px-3 my-2`}>
      <div
        className={`group relative max-w-[80%] px-4 py-2 rounded-2xl shadow-sm transition-colors ${
          self 
            ? "bg-[#e6f0ff] text-black rounded-br-none hover:bg-[#d8e8ff]" 
            : "bg-white text-black rounded-bl-none hover:bg-gray-50 border border-gray-200"
        } text-[13px] leading-relaxed`}
      >
        
        {/* React button moved to footer to avoid overlaying media */}
        {/* Quoted preview */}
        {quotedMessage && (
          <div className={`mb-2 px-2 py-1 rounded border ${self ? 'border-white/30 bg-white/10' : 'border-gray-500 bg-black/10'}`}>
            <div className="text-[10px] opacity-70 mb-0.5">Replying to</div>
            <div className="text-xs truncate max-w-[280px]">
              {(() => {
                try {
                  const t = quotedMessage;
                  if (t.type === 'text') return String(t.message || '').slice(0, 120);
                  if (t.type === 'image') return '🖼️ Image';
                  if (t.type === 'audio') return '🎙️ Audio';
                  if (t.type === 'video') return '🎞️ Video';
                  return String(t.type || 'message');
                } catch { return 'message'; }
              })()}
            </div>
          </div>
        )}
        {/* Content based on message type */}
        {isGroupedImages ? renderGroupedImages() :
         isImage ? renderSingleImage(mediaUrl ? `${API_BASE}/proxy-image?url=${encodeURIComponent(mediaUrl)}` : mediaUrl, "Product", msg.caption || msg.price) :
         isAudio ? renderAudio() :
         isVideo ? renderVideo() :
         isCatalogItem ? (
           <div className="whitespace-pre-line break-words leading-relaxed">
             <div className="text-[10px] uppercase tracking-wide opacity-75 mb-0.5">Product</div>
             {highlightText(msg.message, highlightQuery)}
           </div>
         ) :
         isCatalogSet ? (
           <div className="whitespace-pre-line break-words leading-relaxed">
             <div className="text-[10px] uppercase tracking-wide opacity-75 mb-0.5">Catalog Set</div>
             {highlightText(msg.message, highlightQuery)}
           </div>
         ) :
         isText ? (
           <div className="whitespace-pre-line break-words leading-relaxed">
             {(() => {
               const text = String(msg.message || "");
               const urls = extractUrls(text);
               if (!urls.length) return highlightText(text, highlightQuery);
               const parts = [];
               let lastIndex = 0;
               text.replace(/https?:\/\/[\w.-]+(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/gi, (match, offset) => {
                 const before = text.slice(lastIndex, offset);
                 if (before) parts.push(<React.Fragment key={`t_${lastIndex}`}>{highlightText(before, highlightQuery)}</React.Fragment>);
                 parts.push(
                   <a key={`a_${offset}`} href={match} target="_blank" rel="noopener noreferrer" className="underline text-blue-200 break-all">
                     {match}
                   </a>
                 );
                 lastIndex = offset + match.length;
                 return match;
               });
               const tail = text.slice(lastIndex);
               if (tail) parts.push(<React.Fragment key={`t_tail`}>{highlightText(tail, highlightQuery)}</React.Fragment>);
               return parts;
             })()}
             {(() => {
               const urls = extractUrls(msg?.message);
               const imageUrls = (urls || []).filter(isImageUrl).slice(0, 3);
               if (!imageUrls.length) return null;
              return (
                 <div className="mt-2 flex flex-wrap gap-2">
                   {imageUrls.map((u, i) => (
                     <img
                       key={i}
                      src={`${API_BASE}/proxy-image?url=${encodeURIComponent(u)}&w=256`}
                      srcSet={`${API_BASE}/proxy-image?url=${encodeURIComponent(u)}&w=160 160w, ${API_BASE}/proxy-image?url=${encodeURIComponent(u)}&w=256 256w, ${API_BASE}/proxy-image?url=${encodeURIComponent(u)}&w=384 384w`}
                      sizes="(max-width: 640px) 45vw, 256px"
                       alt="linked"
                       className="rounded-lg max-w-[160px] cursor-pointer hover:opacity-90"
                       onClick={() => window.open(u, '_blank')}
                       onError={(e) => handleImageError(e)}
                      onLoad={() => { const key = `${u}|256`; if (!loadedSrcsRef.current.has(key)) { loadedSrcsRef.current.add(key); notifyResize(); } }}
                       loading="lazy"
                     />
                   ))}
                 </div>
               );
             })()}
             {(() => {
               if (!linkPreview || linkPreviewError) return null;
               const img = linkPreview.image;
               const title = linkPreview.title || linkPreview.url;
               if (!img && !title) return null;
               return (
                 <a
                   href={linkPreview.url || '#'}
                   target="_blank"
                   rel="noopener noreferrer"
                   className="mt-2 block bg-black/20 rounded-lg overflow-hidden border border-gray-600 hover:border-gray-400"
                 >
                   {img && (
                     <img
                      src={`${API_BASE}/proxy-image?url=${encodeURIComponent(img)}&w=512`}
                      srcSet={`${API_BASE}/proxy-image?url=${encodeURIComponent(img)}&w=320 320w, ${API_BASE}/proxy-image?url=${encodeURIComponent(img)}&w=512 512w, ${API_BASE}/proxy-image?url=${encodeURIComponent(img)}&w=640 640w`}
                       alt={title || 'preview'}
                       className="w-full max-w-[260px] object-cover bg-gray-800"
                       style={{ aspectRatio: '1200 / 630' }}
                       onError={(e) => handleImageError(e)}
                      onLoad={() => { const key = `${img}|512`; if (!loadedSrcsRef.current.has(key)) { loadedSrcsRef.current.add(key); notifyResize(); } }}
                       loading="lazy"
                     />
                   )}
                   {title && (
                     <div className="px-2 py-1 text-xs text-white truncate max-w-[260px]">{title}</div>
                   )}
                 </a>
               );
             })()}
           </div>
         ) : (
           <div className="text-xs italic text-gray-300">
             Unsupported message type: {msg.type}
           </div>
        )}

        {/* Message footer with actions, reactions, timestamp and status */}
        <div className="relative mt-1 text-xs opacity-80">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {typeof onReply === 'function' && (
                <button
                  type="button"
                  title="Reply"
                  onClick={(e) => { e.stopPropagation(); onReply(msg); }}
                  className={`${self ? 'bg-white/10 hover:bg-white/20' : 'bg-black/20 hover:bg-black/30'} rounded-md p-1 transition-all focus:outline-none focus:ring-1 focus:ring-white/30 active:scale-95`}
                  aria-label="Reply"
                >
                  <Reply size={14} className="opacity-90" />
                </button>
              )}
              {typeof onForward === 'function' && (
                <button
                  type="button"
                  title="Forward"
                  onClick={(e) => { e.stopPropagation(); onForward(msg); }}
                  className={`${self ? 'bg-white/10 hover:bg-white/20' : 'bg-black/20 hover:bg-black/30'} rounded-md p-1 transition-all focus:outline-none focus:ring-1 focus:ring-white/30 active:scale-95`}
                  aria-label="Forward"
                >
                  <Forward size={14} className="opacity-90" />
                </button>
              )}
              <div className="flex items-center gap-1">
                {Object.entries(msg.reactionsSummary || {}).map(([emj, cnt]) => (
                  <span key={emj} className={`${self ? 'bg-white/15' : 'bg-black/20'} px-1 py-0.5 rounded`}>{emj} {cnt}</span>
                ))}
              </div>
            </div>
            <div className="flex items-center space-x-1">
              {typeof onReact === 'function' && (
                <div className="relative mr-1">
                  <button
                    type="button"
                    title="React"
                    onClick={(e)=>{ e.stopPropagation(); setShowReactPicker(v=>!v); }}
                    className={`${self ? 'bg-white/10 hover:bg-white/20' : 'bg-black/20 hover:bg-black/30'} rounded px-1 py-0.5 transition-colors`}
                  >😊</button>
                  {showReactPicker && (
                    <div className={`absolute bottom-full mb-1 left-0 z-10 bg-gray-800 text-white rounded shadow px-1 py-1 flex space-x-1 select-none`}
                      onClick={(e)=>e.stopPropagation()}
                    >
                      {['👍','❤️','😂','😮','😢','🙏'].map((emj)=>(
                        <button key={emj} className="hover:bg-gray-700 rounded px-1" onClick={()=>{ setShowReactPicker(false); onReact(msg, emj); }}>{emj}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <span>{formatTime(msg.timestamp)}</span>
              {renderTick(msg, self)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}