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
  if (/^https?:\/\//i.test(raw)) return raw;
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

export default function MessageBubble({ msg, self, catalogProducts = {} }) {
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

  // Improved media URL resolution with priority handling
  const mediaUrl = (() => {
    // Priority: msg.url > msg.message (if string and not text) > empty
    if (msg.url) return getSafeMediaUrl(msg.url);
    if (typeof msg.message === "string" && msg.type !== "text" && msg.type !== "order") {
      return getSafeMediaUrl(msg.message);
    }
    return "";
  })();

  // Enhanced media type detection
  const isGroupedImages = Array.isArray(msg.message) && 
    msg.message.length > 0 && 
    msg.message.every(item => item && (item.type === "image" || typeof item.message === "string"));
  
  const isImage = msg.type === "image" && !isGroupedImages;
  const isAudio = msg.type === "audio";
  const isVideo = msg.type === "video";
  const isText = msg.type === "text" || (!isImage && !isAudio && !isVideo && !isOrder && !isGroupedImages);

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

  // WaveSurfer setup with better error handling
  useEffect(() => {
    let wavesurfer = null;
    
    if (isAudio && waveformRef.current && mediaUrl) {
      // Cleanup existing instance
      if (wavesurferRef.current) {
        try { 
          wavesurferRef.current.destroy(); 
        } catch (e) {
          console.warn("Error destroying previous wavesurfer:", e);
        }
        wavesurferRef.current = null;
      }

      try {
        wavesurfer = WaveSurfer.create({
          container: waveformRef.current,
          waveColor: "#8ecae6",
          progressColor: "#219ebc",
          height: 40,
          barWidth: 2,
          barRadius: 1,
          responsive: true,
          interact: true,
          normalize: true,
          backend: "MediaElement",
          mediaType: "audio",
        });

        setAudioError(false);
        wavesurfer.load(mediaUrl, { crossOrigin: "anonymous" });

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
  }, [mediaUrl, isAudio]);

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
          mediaUrl ? (
            <audio
              controls
              src={mediaUrl}
              crossOrigin="anonymous"
              className="flex-1 min-w-[180px] max-w-[320px] h-[48px] mb-1"
            >
              Your browser does not support the audio element.
            </audio>
          ) : (
            <div className="flex-1 min-w-[180px] text-xs text-red-300 italic">
              Audio file missing or failed to load
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
                
                return (
                  <li
                    key={i}
                    className="flex items-center rounded-xl bg-white/95 border border-blue-200 shadow-sm p-3 gap-3 transition-all hover:shadow-md hover:bg-blue-50/50"
                  >
                    <div className="flex-shrink-0">
                      {product.image ? (
                        <img
                          src={product.image}
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
                      </div>
                      
                      {product.price && product.price !== item.item_price && (
                        <div className="mt-2">
                          <span className="inline-block text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full border border-blue-100">
                            <span className="font-medium">Catalog Price:</span> {product.price} {item.currency || "MAD"}
                          </span>
                        </div>
                      )}
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
        className={`max-w-[80%] px-3 py-2 rounded-2xl shadow-md transition-all hover:shadow-lg ${
          self 
            ? "bg-[#004AAD] text-white rounded-br-none" 
            : "bg-gray-700 text-white rounded-bl-none"
        }`}
      >
        {/* Content based on message type */}
        {isGroupedImages ? renderGroupedImages() :
         isImage ? renderSingleImage(mediaUrl, "Product", msg.caption || msg.price) :
         isAudio ? renderAudio() :
         isVideo ? renderVideo() :
         isText ? (
           <div className="whitespace-pre-line break-words leading-relaxed">
             {msg.message}
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