import { openDB } from 'idb';

const DB_NAME = 'chat-db';
const STORE_MESSAGES = 'messages';
const STORE_CONVERSATIONS = 'conversations';
const DB_VERSION = 2;

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1 && !db.objectStoreNames.contains(STORE_MESSAGES)) {
        db.createObjectStore(STORE_MESSAGES);
      }
      if (oldVersion < 2 && !db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        db.createObjectStore(STORE_CONVERSATIONS);
      }
    }
  });
}

export async function saveMessages(userId, messageArray) {
  if (!userId) return;
  const db = await getDB();
  const msgs = Array.isArray(messageArray) ? messageArray.slice(-100) : [];
  await db.put(STORE_MESSAGES, msgs, userId);
}

export async function loadMessages(userId) {
  if (!userId) return [];
  const db = await getDB();
  const msgs = await db.get(STORE_MESSAGES, userId);
  return Array.isArray(msgs) ? msgs : [];
}

export async function saveConversations(conversationArray) {
  const db = await getDB();
  const list = Array.isArray(conversationArray) ? conversationArray : [];
  await db.put(STORE_CONVERSATIONS, list, 'list');
}

export async function loadConversations() {
  const db = await getDB();
  const convs = await db.get(STORE_CONVERSATIONS, 'list');
  return Array.isArray(convs) ? convs : [];
}
