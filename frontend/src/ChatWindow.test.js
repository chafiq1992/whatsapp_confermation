import React from 'react';
import { render, act } from '@testing-library/react';
import ChatWindow from './ChatWindow';
import useAudioRecorder from './useAudioRecorder';
import api from './api';

jest.mock('./useAudioRecorder');

jest.mock('./api', () => ({
  post: jest.fn(() => Promise.resolve({ data: {} })),
  get: jest.fn(() => Promise.resolve({ data: [] })),
  isCancel: jest.fn(() => false),
}));

jest.mock('./chatStorage', () => {
  const loadMessages = jest.fn();
  loadMessages.mockResolvedValue([]);
  const saveMessages = jest.fn();
  saveMessages.mockResolvedValue();
  return {
    __esModule: true,
    loadMessages,
    saveMessages,
  };
});

jest.mock('./CatalogPanel', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('wavesurfer.js', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      load: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      un: jest.fn(),
      destroy: jest.fn(),
      play: jest.fn(),
      pause: jest.fn(),
      setPlaybackRate: jest.fn(),
    })),
  },
}));

describe('ChatWindow audio blob lifecycle', () => {
  let capturedOnComplete;
  let emitWsMessage;
  let latestTempId;
  const originalCreateObjectURL = global.URL && global.URL.createObjectURL;
  const originalRevokeObjectURL = global.URL && global.URL.revokeObjectURL;
  const originalAlert = global.alert;

  beforeAll(() => {
    global.WebSocket = global.WebSocket || { OPEN: 1 };
    global.ResizeObserver = global.ResizeObserver || class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  beforeEach(() => {
    capturedOnComplete = null;
    latestTempId = null;
    const messageListeners = new Set();
    const ws = {
      readyState: 1,
      addEventListener: jest.fn((type, cb) => {
        if (type === 'message') messageListeners.add(cb);
      }),
      removeEventListener: jest.fn((type, cb) => {
        if (type === 'message') messageListeners.delete(cb);
      }),
      send: jest.fn(),
    };
    emitWsMessage = (payload) => {
      messageListeners.forEach((cb) => cb({ data: JSON.stringify(payload) }));
    };

    const chatStorage = require('./chatStorage');
    chatStorage.loadMessages.mockImplementation(() => Promise.resolve([]));
    chatStorage.saveMessages.mockImplementation(() => Promise.resolve());

    useAudioRecorder.mockImplementation((userId, onComplete) => {
      capturedOnComplete = onComplete;
      return {
        isRecording: false,
        recordingTime: 0,
        startRecording: jest.fn(),
        stopRecording: jest.fn(),
        cancelRecording: jest.fn(),
        setCanvasRef: jest.fn(),
      };
    });

    api.post.mockImplementation((url, body) => {
      if (url.includes('send-media-async')) {
        if (body && typeof body.get === 'function') {
          latestTempId = body.get('temp_id');
        }
        return Promise.resolve({ data: {} });
      }
      return Promise.resolve({ data: {} });
    });

    global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = jest.fn();
    global.alert = jest.fn();

    render(
      <ChatWindow
        activeUser={{ user_id: 'user-1' }}
        ws={ws}
        adminWs={null}
        currentAgent={{}}
        onUpdateConversationTags={jest.fn()}
      />
    );
  });

  afterEach(() => {
    if (originalCreateObjectURL) {
      global.URL.createObjectURL = originalCreateObjectURL;
    } else {
      delete global.URL.createObjectURL;
    }
    if (originalRevokeObjectURL) {
      global.URL.revokeObjectURL = originalRevokeObjectURL;
    } else {
      delete global.URL.revokeObjectURL;
    }
    if (typeof originalAlert === 'function') {
      global.alert = originalAlert;
    } else {
      delete global.alert;
    }
  });

  test('defers blob revocation until durable url is present', async () => {
    expect(capturedOnComplete).toBeInstanceOf(Function);
    const file = new File(['123'], 'voice_note.webm', { type: 'audio/webm' });

    await act(async () => {
      await capturedOnComplete(file);
    });

    expect(global.URL.createObjectURL).toHaveBeenCalledWith(file);
    expect(global.URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(latestTempId).toBeTruthy();
    const tempId = latestTempId;

    await act(async () => {
      emitWsMessage({
        type: 'message_status_update',
        data: { temp_id: tempId, url: 'https://cdn.example.com/audio.ogg' },
      });
    });

    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});
