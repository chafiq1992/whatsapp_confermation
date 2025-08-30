import React, { useRef, useState } from 'react';
import fetchWithAuth from './fetchWithAuth';

export default function ImageUploader({ userId, onImagesSent, ws }) {
  const [isUploading, setIsUploading] = useState(false);
  const [thumbnails, setThumbnails] = useState([]);
  const fileInputRef = useRef();

  // Utility to get API URL
  const API_BASE = process.env.REACT_APP_API_BASE || "";

  // Function to handle upload - now compatible with ChatWindow's approach
  const handleFileUpload = async (files) => {
    setIsUploading(true);
    
    try {
      // Upload each file individually to match ChatWindow's backend expectation
      for (const file of files) {
        const formData = new FormData();
        formData.append('files', file); // Changed from 'file' to 'files' to match ChatWindow
        formData.append('user_id', userId);
        formData.append('media_type', 'image');

        console.log('📤 Uploading file:', file.name, 'to user:', userId);

        // Send via WebSocket if available (like ChatWindow does)
        if (ws && ws.readyState === WebSocket.OPEN) {
          // For WebSocket, we still use HTTP upload but let WS handle real-time updates
          const response = await fetchWithAuth(`${API_BASE}/send-media`, {
            method: 'POST',
            body: formData,
          });

          const result = await response.json();
          console.log('✅ Upload response:', result);

          if (!response.ok || result.status !== 'success') {
            throw new Error(result.error || `HTTP ${response.status}: ${response.statusText}`);
          }
          // WebSocket will handle the UI update automatically
        } else {
          // Fallback to HTTP-only approach
          const response = await fetchWithAuth(`${API_BASE}/send-media`, {
            method: 'POST',
            body: formData,
          });

          const result = await response.json();
          console.log('✅ Upload response:', result);

          if (!response.ok || result.status !== 'success') {
            throw new Error(result.error || `HTTP ${response.status}: ${response.statusText}`);
          }
        }
      }

      setThumbnails([]); // Clear previews after successful upload
      if (onImagesSent) {
        onImagesSent(files);
      }

    } catch (error) {
      console.error("❌ Upload failed:", error);
      
      // Show user-friendly error message
      const errorMessage = error.message || 'Upload failed';
      alert(`Failed to send image(s): ${errorMessage}`);
      
    } finally {
      setIsUploading(false);
    }
  };

  // Preview thumbnail images before uploading
  const previewImages = (files) => {
    const fileArray = Array.from(files);
    
    // Validate file types
    const validFiles = fileArray.filter(file => {
      if (!file.type.startsWith('image/')) {
        alert(`${file.name} is not a valid image file`);
        return false;
      }
      // Check file size (max 16MB for WhatsApp)
      if (file.size > 16 * 1024 * 1024) {
        alert(`${file.name} is too large. Maximum size is 16MB`);
        return false;
      }
      return true;
    });

    if (validFiles.length === 0) {
      return [];
    }

    // Create thumbnails
    const newThumbs = validFiles.map(file => ({
      url: URL.createObjectURL(file),
      name: file.name
    }));
    
    setThumbnails(newThumbs);
    return validFiles;
  };

  // Handle files from input
  const handleFileChange = (e) => {
    const files = previewImages(e.target.files);
    if (files.length > 0) {
      handleFileUpload(files);
    }
    // Reset input value to allow same file to be selected again
    e.target.value = '';
  };

  // Handle files when pasted
  const handlePaste = (event) => {
    const items = event.clipboardData.items;
    const files = [];
    
    for (let item of items) {
      if (item.type.indexOf("image") !== -1) {
        const blob = item.getAsFile();
        if (blob) {
          files.push(blob);
        }
      }
    }
    
    if (files.length > 0) {
      const validFiles = previewImages(files);
      if (validFiles.length > 0) {
        handleFileUpload(validFiles);
      }
    }
  };

  // Handle drag & drop
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const files = Array.from(e.dataTransfer.files);
    const validFiles = previewImages(files);
    if (validFiles.length > 0) {
      handleFileUpload(validFiles);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // Clear thumbnails
  const clearThumbnails = () => {
    thumbnails.forEach(thumb => URL.revokeObjectURL(thumb.url));
    setThumbnails([]);
  };

  // Connection status indicator
  const isConnected = ws && ws.readyState === WebSocket.OPEN;

  return (
    <div
      className="p-4 border-2 border-dashed border-gray-300 rounded-lg bg-gray-50"
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      tabIndex={0} // Make div focusable for paste events
    >
      <div className="flex items-center justify-between mb-3">
        <button
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            isUploading 
              ? 'bg-gray-400 text-white cursor-not-allowed' 
              : 'bg-green-600 hover:bg-green-700 text-white'
          }`}
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? (
            <span className="flex items-center">
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Uploading...
            </span>
          ) : (
            '📤 Upload Images'
          )}
        </button>

        {/* Connection status */}
        <div className="flex items-center space-x-2">
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
          <span className="text-xs text-gray-600">
            {isConnected ? 'Connected' : 'Offline'}
          </span>
        </div>

        {thumbnails.length > 0 && !isUploading && (
          <button
            onClick={clearThumbnails}
            className="text-red-500 hover:text-red-700 text-sm"
          >
            Clear
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        multiple
        onChange={handleFileChange}
      />

      {/* Instructions */}
      <p className="text-sm text-gray-600 mb-3">
        Click to upload, drag & drop, or paste images (Max 16MB each)
      </p>

      {/* Preview thumbnails */}
      {thumbnails.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-gray-700 mb-2">
            Ready to send ({thumbnails.length} image{thumbnails.length > 1 ? 's' : ''}):
          </p>
          <div className="flex flex-wrap gap-2">
            {thumbnails.map((thumb, idx) => (
              <div key={idx} className="relative">
                <img
                  src={thumb.url}
                  alt={`Preview ${idx + 1}`}
                  className="w-16 h-16 object-cover rounded-lg border-2 border-gray-300"
                />
                <div className="absolute -top-1 -right-1 bg-gray-800 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {idx + 1}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upload status */}
      {isUploading && (
        <div className="mt-3 p-2 bg-blue-100 border border-blue-300 rounded text-blue-800 text-sm">
          Sending images to WhatsApp...
        </div>
      )}
    </div>
  );
}