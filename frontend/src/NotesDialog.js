import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from './api';
import useAudioRecorder from './useAudioRecorder';

export default function NotesDialog({ open, onClose, userId, currentAgent }) {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState("");
  const listRef = useRef(null);

  const {
    isRecording,
    recordingTime,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useAudioRecorder(userId, async (file) => {
    try {
      // Upload audio as internal note attachment (no WhatsApp send)
      const form = new FormData();
      form.append('file', file);
      const res = await api.post(`/notes/upload`, form);
      const url = res?.data?.url || res?.data?.file_path;
      if (!url) throw new Error('No audio URL');
      await addNote({ type: 'audio', url });
    } catch (e) {
      alert('Failed to upload audio note');
    }
  }, { maxDuration: 180 });

  const fetchNotes = async () => {
    if (!userId) return;
    try {
      const res = await api.get(`/conversations/${userId}/notes`);
      setNotes(Array.isArray(res.data) ? res.data : []);
    } catch {}
  };

  useEffect(() => {
    if (open) fetchNotes();
  }, [open, userId]);

  const addNote = async ({ type = 'text', text: txt, url }) => {
    if (!userId) return;
    try {
      const payload = { note_type: type, text: txt, url, agent_username: currentAgent || undefined };
      const res = await api.post(`/conversations/${userId}/notes`, payload);
      const added = res.data;
      setNotes(prev => [...prev, added]);
      setText("");
      try { window.dispatchEvent(new CustomEvent('note-added', { detail: { user_id: userId } })); } catch {}
      setTimeout(() => {
        try {
          const el = listRef.current;
          if (el) {
            el.scrollTop = el.scrollHeight || 0;
          }
        } catch {}
      }, 50);
    } catch {}
  };

  const deleteNote = async (id) => {
    try {
      await api.delete(`/conversations/notes/${id}`);
      setNotes(prev => prev.filter(n => n.id !== id));
      try { window.dispatchEvent(new CustomEvent('note-deleted', { detail: { user_id: userId } })); } catch {}
    } catch {}
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-gray-900 text-white rounded-lg p-3 w-[760px] max-w-[95vw]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold">Conversation Notes</div>
          <button className="px-3 py-1 bg-gray-700 rounded" onClick={onClose}>Close</button>
        </div>

        <div className="flex items-center gap-2 mb-2">
          <input
            className="flex-1 px-2 py-1 bg-gray-800 rounded"
            placeholder="Add a note for other agents…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) addNote({ type: 'text', text: text.trim() }); }}
          />
          <button
            className="px-3 py-1 bg-blue-600 rounded disabled:opacity-50"
            disabled={!text.trim()}
            onClick={() => addNote({ type: 'text', text: text.trim() })}
          >Add</button>
          {!isRecording ? (
            <button className="px-3 py-1 bg-emerald-700 rounded" onClick={startRecording} title="Record audio note">Record</button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-300">Rec {recordingTime}s</span>
              <button className="px-2 py-1 bg-yellow-600 rounded" onClick={stopRecording}>Stop</button>
              <button className="px-2 py-1 bg-gray-600 rounded" onClick={cancelRecording}>Cancel</button>
            </div>
          )}
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto space-y-2 border-t border-gray-800 pt-2">
          {notes.length === 0 && (
            <div className="text-sm text-gray-400">No notes yet.</div>
          )}
          {notes.map(n => (
            <div key={n.id || `${n.created_at}_${n.url || n.text}`} className="flex items-start justify-between bg-gray-800 rounded p-2">
              <div className="text-sm">
                <div className="text-xs text-gray-400">
                  {new Date(n.created_at || Date.now()).toLocaleString()} {n.agent_username ? `· ${n.agent_username}` : ''}
                </div>
                {n.type === 'audio' && n.url ? (
                  <audio controls src={n.signed_url || n.url} className="mt-1" />
                ) : (
                  <div className="mt-1 whitespace-pre-wrap break-words">{n.text}</div>
                )}
              </div>
              <button className="px-2 py-1 bg-red-700 rounded text-xs ml-2" onClick={() => deleteNote(n.id)}>Delete</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


