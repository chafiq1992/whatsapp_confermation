import React, { useCallback, useMemo, useRef, useState, Suspense } from 'react';
import { HiPaperAirplane, HiPaperClip, HiMicrophone, HiFaceSmile } from 'react-icons/hi2';

const EmojiPicker = React.lazy(() => import('emoji-picker-react'));

function ComposerInternal({
  isRecording,
  recordingTime,
  startRecording,
  stopRecording,
  cancelRecording,
  canvasRef,
  onSendText,
  onTypingStart,
  onTypingStop,
  onClickAttach,
  onFileInputChange,
  fileInputRef,
  isUploading,
}) {
  const [text, setText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const inputRef = useRef();
  const lastInputHeightRef = useRef(0);

  const formatTime = useCallback((sec) => {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }, []);

  const handleSend = useCallback(() => {
    const value = String(text || '').trim();
    if (!value) return;
    onSendText && onSendText(value);
    setText('');
    try { if (inputRef.current) { inputRef.current.style.height = 'auto'; lastInputHeightRef.current = 0; } } catch {}
  }, [text, onSendText]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleTextChange = useCallback((e) => {
    const val = e.target.value;
    setText(val);
    try {
      if (inputRef.current) {
        const prev = lastInputHeightRef.current || 0;
        inputRef.current.style.height = 'auto';
        const next = Math.min(160, inputRef.current.scrollHeight);
        if (Math.abs(next - prev) > 2) {
          inputRef.current.style.height = `${next}px`;
          lastInputHeightRef.current = next;
        } else {
          if (prev) inputRef.current.style.height = `${prev}px`;
        }
      }
    } catch {}
    onTypingStart && onTypingStart();
    clearTimeout(handleTextChange._t);
    handleTextChange._t = setTimeout(() => { onTypingStop && onTypingStop(); }, 250);
  }, [onTypingStart, onTypingStop]);

  const toggleEmoji = useCallback(() => setShowEmojiPicker((v) => !v), []);

  return (
    <div className="flex flex-col space-y-2 relative">
      {isRecording && (
        <div className="bg-black p-2 rounded text-white flex items-center justify-between">
          <span className="text-green-400">🎙️ Recording... {formatTime(recordingTime)}</span>
          <canvas ref={canvasRef} width={200} height={40} className="mx-2 bg-gray-900 rounded" />
          <button
            onClick={stopRecording}
            className="bg-green-600 px-3 py-1 rounded text-white"
          >
            ✅ Send
          </button>
          <button
            onClick={cancelRecording}
            className="bg-red-600 px-3 py-1 rounded text-white ml-2"
          >
            ❌ Cancel
          </button>
        </div>
      )}
      {showEmojiPicker && (
        <div className="absolute -top-56 left-2 z-10 bg-white rounded shadow">
          <Suspense fallback={<div className="p-2 text-sm">Loading…</div>}>
            <EmojiPicker onEmojiClick={(emojiData) => setText((prev) => prev + emojiData.emoji)} />
          </Suspense>
        </div>
      )}
      <div className="flex items-center">
        <div className="flex items-center gap-2 flex-1 bg-gray-700 rounded-full px-3 py-2">
          <button
            onClick={toggleEmoji}
            className="text-[#5AA0FF] hover:opacity-90"
            disabled={isRecording}
            title="Emoji"
          >
            <HiFaceSmile size={20} />
          </button>
          <textarea
            ref={inputRef}
            className="flex-1 bg-transparent text-white placeholder-gray-300 outline-none resize-none leading-5 max-h-40"
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message"
            disabled={isRecording}
            rows={1}
            aria-label="Message input"
          />
          {!isRecording && (
            <>
              <input
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                ref={fileInputRef}
                onChange={onFileInputChange}
              />
              <button
                className="text-[#5AA0FF] hover:opacity-90"
                onClick={onClickAttach}
                disabled={isUploading}
                title="Attach images"
                tabIndex={-1}
              >
                <HiPaperClip size={20} />
              </button>
              <button
                onClick={startRecording}
                className="text-[#5AA0FF] hover:opacity-90"
                title="Record audio"
              >
                <HiMicrophone size={20} />
              </button>
            </>
          )}
          <button
            onClick={handleSend}
            className="ml-1 text-[#5AA0FF] hover:opacity-90 disabled:opacity-40"
            disabled={isRecording || !String(text || '').trim()}
            title="Send"
          >
            <HiPaperAirplane size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

const propsAreEqual = (prev, next) => (
  prev.isRecording === next.isRecording &&
  prev.recordingTime === next.recordingTime &&
  prev.startRecording === next.startRecording &&
  prev.stopRecording === next.stopRecording &&
  prev.cancelRecording === next.cancelRecording &&
  prev.canvasRef === next.canvasRef &&
  prev.onSendText === next.onSendText &&
  prev.onTypingStart === next.onTypingStart &&
  prev.onTypingStop === next.onTypingStop &&
  prev.onClickAttach === next.onClickAttach &&
  prev.onFileInputChange === next.onFileInputChange &&
  prev.fileInputRef === next.fileInputRef &&
  prev.isUploading === next.isUploading
);

export default React.memo(ComposerInternal, propsAreEqual);


