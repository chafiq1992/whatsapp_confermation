import React, { useRef, useEffect, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Clock3, Check, CheckCheck, XCircle } from "lucide-react"; // 14 KB gzipped

/* prettier, pixel-perfect WhatsApp ticks */
const ICONS = {
  sending:   <Clock3     size={15} className="text-gray-400" />,
  sent:      <Check      size={15} className="text-gray-400" />,
  delivered: <CheckCheck size={15} className="text-gray-400" />,
  read:      <CheckCheck size={15} className="text-blue-500" />,
  failed:    <XCircle    size={15} className="text-red-500" />,
};

// Enhanced media URL utility with better error handling
export function getSafeMediaUrl(raw) {
  if (!raw) return "";
  if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
  if (raw.startsWith("/app/")) {
    raw = raw.replace(/^\/app\/(media\/)?/, "/media/");
  }
  const base = process.env.REACT_APP_API_BASE || "";
  return `${base.replace(/\/$/, "")}/${raw.replace(/^\/+/, "")}`;
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
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  } catch {
    return ts.length > 15 ? ts.slice(11, 16) : ts;
  }
}

export default function MessageBubble({ msg, self, catalogProducts = {}, highlightQuery = "", onForward }) {
  const API_BASE = process.env.REACT_APP_API_BASE || "";
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

  // Compute possible media URLs
  const primaryUrl = msg.url ? getSafeMediaUrl(msg.url) : "";
  const localUrl =
    typeof msg.message === "string" &&
    msg.type !== "text" &&
    msg.type !== "order" &&
    !/^https?:\/\//i.test(msg.message)
      ? getSafeMediaUrl(msg.message)
      : "";

  const isAudio = msg.type === "audio";

  // Best available URL for media
  const mediaUrl = primaryUrl || localUrl;
  // Use backend proxy for audio to avoid CORS issues when drawing waveform
  const effectiveAudioUrl = isAudio
    ? (primaryUrl && /^https?:\/\//i.test(primaryUrl)
        ? `${API_BASE}/proxy-audio?url=${encodeURIComponent(primaryUrl)}`
        : primaryUrl)
    : null;

  // Track which URL is currently used by the audio player
  const [activeUrl, setActiveUrl] = useState(mediaUrl);

  useEffect(() => {
    setActiveUrl(mediaUrl);
  }, [mediaUrl]);

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

  useEffect(() => {
    if (!isText) return;
    const urls = extractUrls(msg?.message);
    if (!urls.length) return;
    const firstPageUrl = urls.find(u => !isImageUrl(u));
    if (!firstPageUrl) return;
    let aborted = false;
    (async () => {
      try {
        setLinkPreviewError(false);
        const res = await fetch(`${API_BASE}/link-preview?url=${encodeURIComponent(firstPageUrl)}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!aborted) setLinkPreview(data);
      } catch (e) {
        if (!aborted) setLinkPreviewError(true);
      }
    })();
    return () => { aborted = true; };
  }, [isText, msg?.message, API_BASE]);

  // Audio player state and refs
  const waveformRef = useRef(null);
  const wavesurferRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [audioError, setAudioError] = useState(false);

  // Video player state and refs
  const [videoError, setVideoError] = useState(false);

  // Enhanced image error handling
  const handleImageError = (e, fallbackSrc = "/broken-image.png") => {
    if (e.target.src === fallbackSrc) return; // Prevent infinite loops
    e.target.onerror = null;
    e.target.src = fallbackSrc;
    e.target.alt = "Image failed to load";
  };

  // WaveSurfer setup relying solely on msg.url
  useEffect(() => {
    if (!isAudio) return;

    const url = effectiveAudioUrl || primaryUrl;
    if (!url) {
      setAudioError(true);
      setActiveUrl("");
      return;
    }

    let wavesurfer = null;

    if (waveformRef.current) {
      if (wavesurferRef.current) {
        try {
          wavesurferRef.current.destroy();
        } catch (e) {
          console.warn("Error destroying previous wavesurfer:", e);
        }
        wavesurferRef.current = null;
      }

      try {
        setActiveUrl(url);
        wavesurfer = WaveSurfer.create({
          container: waveformRef.current,
          url,
          waveColor: "#8ecae6",
          progressColor: "#219ebc",
          height: 48,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          cursorWidth: 1,
          interact: true,
          normalize: true,
          backend: 'MediaElement',
        });

        setAudioError(false);

        wavesurfer.on("ready", () => setAudioError(false));
        wavesurfer.on("finish", () => setPlaying(false));
        wavesurfer.on("error", (error) => {
          console.error("WaveSurfer error:", error);
          setAudioError(true);
        });

        wavesurferRef.current = wavesurfer;
      } catch (err) {
        console.error("WaveSurfer initialization error:", err);
        setAudioError(true);
      }
    }

    return () => {
      if (wavesurfer) {
        try {
          wavesurfer.destroy();
        } catch (e) {
          console.warn("Error cleaning up wavesurfer:", e);
        }
      }
      if (wavesurferRef.current) {
        try {
          wavesurferRef.current.destroy();
        } catch (e) {
          console.warn("Error cleaning up wavesurfer ref:", e);
        }
        wavesurferRef.current = null;
      }
    };
  }, [primaryUrl, isAudio]);

  // Audio play/pause handler with error handling
  const handlePlayPause = () => {
    if (!wavesurferRef.current || audioError) return;
    
    try {
      if (wavesurferRef.current.isPlaying()) {
        wavesurferRef.current.pause();
        setPlaying(false);
      } else {
        wavesurferRef.current.play();
        setPlaying(true);
      }
    } catch (error) {
      console.error("Audio playback error:", error);
      setPlaying(false);
      setAudioError(true);
    }
  };

  // Enhanced single image renderer
  const renderSingleImage = (src, alt, caption) => (
    <div className="flex flex-col">
      <img
        src={src}
        alt={alt}
        className="rounded-xl mb-1 max-w-[250px] cursor-pointer hover:opacity-90 transition-opacity"
        onError={(e) => handleImageError(e)}
        loading="lazy"
        onClick={() => window.open(src, '_blank')} // Allow full-size viewing
      />
      {caption && (
        <div className="text-xs mt-1 text-gray-200 bg-black bg-opacity-50 px-2 py-1 rounded backdrop-blur-sm">
          {caption}
        </div>
      )}
    </div>
  );

  // Enhanced grouped images renderer
  const renderGroupedImages = () => (
    <div className={`grid ${msg.message.length > 2 ? "grid-cols-2" : "grid-cols-1"} gap-2`}>
      {msg.message.map((img, idx) => {
        const imgSrc = getSafeMediaUrl(img.url || img.message);
        const imgCaption = img.caption || img.price;
        
        return (
          <div key={idx} className="flex flex-col items-center">
            <img
              src={imgSrc}
              alt={`Image ${idx + 1}`}
              className="rounded-xl mb-1 max-w-[120px] cursor-pointer hover:opacity-90 transition-opacity"
              onError={(e) => handleImageError(e)}
              loading="lazy"
              onClick={() => window.open(imgSrc, '_blank')}
            />
            {imgCaption && (
              <div className="text-xs mt-1 text-gray-200 bg-black bg-opacity-50 px-2 py-1 rounded backdrop-blur-sm">
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
          disabled={audioError}
          className={`mr-2 rounded-full w-8 h-8 flex items-center justify-center focus:outline-none transition-colors ${
            audioError 
              ? 'bg-red-500 cursor-not-allowed' 
              : 'bg-gray-600 hover:bg-gray-500'
          }`}
          aria-label={playing ? "Pause audio" : "Play audio"}
        >
          {audioError ? (
            <span className="text-xs">✖</span>
          ) : playing ? (
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
        
          {audioError ? (
            primaryUrl ? (
              <div className="flex-1 min-w-[180px] max-w-[320px]">
                <audio
                  controls
                  src={primaryUrl}
                  className="w-full"
                  preload="metadata"
                >
                  Your browser does not support the audio element.
                </audio>
                <div className="mt-1 text-[11px] text-red-300 italic">
                  Waveform unavailable. Falling back to basic player.
                  <a
                    href={primaryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 text-blue-300 underline"
                  >
                    Download
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex-1 min-w-[180px] text-xs text-red-300 italic">
                Audio URL missing
              </div>
            )
          ) : (
            <div
              ref={waveformRef}
              className="flex-1 min-w-[180px] max-w-[320px] h-[48px] mb-1"
            />
          )}
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
        src={mediaUrl}
        className="mb-1 max-w-[250px] rounded-xl"
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
      <div className={`flex ${self ? "justify-end" : "justify-start"} px-2 mb-2`}>
        <div className="max-w-[85%] px-4 py-3 rounded-2xl shadow-lg bg-gradient-to-br from-yellow-50 to-orange-50 border-2 border-yellow-300">
          {renderOrder()}
          <div className="flex items-center justify-end mt-3 pt-2 border-t border-yellow-200">
            <span className="text-xs text-gray-600">{formatTime(msg.timestamp)}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${self ? "justify-end" : "justify-start"} px-2 mb-2`}>
      <div
        className={`relative max-w-[80%] px-3 py-2 rounded-2xl shadow-md transition-all hover:shadow-lg ${
          self 
            ? "bg-[#004AAD] text-white rounded-br-none" 
            : "bg-gray-700 text-white rounded-bl-none"
        }`}
      >
        {!self && typeof onForward === 'function' && (
          <button
            type="button"
            title="Forward"
            onClick={(e) => { e.stopPropagation(); onForward(msg); }}
            className="absolute -top-2 -right-2 bg-gray-800 text-white rounded-full w-6 h-6 text-xs flex items-center justify-center shadow hover:bg-gray-700"
          >↪</button>
        )}
        {/* Content based on message type */}
        {isGroupedImages ? renderGroupedImages() :
         isImage ? renderSingleImage(mediaUrl, "Product", msg.caption || msg.price) :
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
                       src={`${API_BASE}/proxy-image?url=${encodeURIComponent(u)}`}
                       alt="linked"
                       className="rounded-lg max-w-[160px] cursor-pointer hover:opacity-90"
                       onClick={() => window.open(u, '_blank')}
                       onError={(e) => handleImageError(e)}
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
                       src={`${API_BASE}/proxy-image?url=${encodeURIComponent(img)}`}
                       alt={title || 'preview'}
                       className="w-full max-w-[260px] object-cover"
                       onError={(e) => handleImageError(e)}
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

        {/* Message footer with timestamp and status */}
        <div className="flex items-center justify-end mt-1 text-xs opacity-75 space-x-1">
          <span>{formatTime(msg.timestamp)}</span>
          {renderTick(msg, self)}
        </div>
      </div>
    </div>
  );
}