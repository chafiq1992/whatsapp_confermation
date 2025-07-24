import { openDB } from 'idb';

const DB_NAME = 'chat-db';
const STORE_NAME = 'messages';
const DB_VERSION = 1;

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    }
  });
}

export async function saveMessages(userId, messageArray) {
  if (!userId) return;
  const db = await getDB();
  const msgs = Array.isArray(messageArray) ? messageArray.slice(-100) : [];
  await db.put(STORE_NAME, msgs, userId);
}

export async function loadMessages(userId) {
  if (!userId) return [];
  const db = await getDB();
  const msgs = await db.get(STORE_NAME, userId);
  return Array.isArray(msgs) ? msgs : [];
}
