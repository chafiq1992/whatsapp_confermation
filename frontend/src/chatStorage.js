import { openDB } from 'idb';

const DB_NAME = 'chat-db';
const STORE_MESSAGES = 'messages';
const STORE_CONVERSATIONS = 'conversations';
const STORE_CATALOG_SETS = 'catalog_sets';
const STORE_CATALOG_SET_PRODUCTS = 'catalog_set_products';
const STORE_CARTS = 'carts';
const DB_VERSION = 4;

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1 && !db.objectStoreNames.contains(STORE_MESSAGES)) {
        db.createObjectStore(STORE_MESSAGES);
      }
      if (oldVersion < 2 && !db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        db.createObjectStore(STORE_CONVERSATIONS);
      }
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains(STORE_CATALOG_SETS)) {
          db.createObjectStore(STORE_CATALOG_SETS);
        }
        if (!db.objectStoreNames.contains(STORE_CATALOG_SET_PRODUCTS)) {
          db.createObjectStore(STORE_CATALOG_SET_PRODUCTS);
        }
      }
      if (oldVersion < 4 && !db.objectStoreNames.contains(STORE_CARTS)) {
        db.createObjectStore(STORE_CARTS);
      }
    }
  });
}

export async function saveMessages(userId, messageArray) {
  if (!userId) return;
  const db = await getDB();
  const msgs = Array.isArray(messageArray) ? messageArray.slice(-300) : [];
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

// Catalog caching
export async function saveCatalogSets(setsArray) {
  const db = await getDB();
  const list = Array.isArray(setsArray) ? setsArray : [];
  await db.put(STORE_CATALOG_SETS, list, 'list');
}

export async function loadCatalogSets() {
  const db = await getDB();
  const sets = await db.get(STORE_CATALOG_SETS, 'list');
  return Array.isArray(sets) ? sets : [];
}

export async function saveCatalogSetProducts(setId, productsArray) {
  if (!setId) return;
  const db = await getDB();
  const list = Array.isArray(productsArray) ? productsArray : [];
  await db.put(STORE_CATALOG_SET_PRODUCTS, list, String(setId));
}

export async function loadCatalogSetProducts(setId) {
  if (!setId) return [];
  const db = await getDB();
  const products = await db.get(STORE_CATALOG_SET_PRODUCTS, String(setId));
  return Array.isArray(products) ? products : [];
}

// Carts per conversation with TTL
const CART_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export async function saveCart(userId, items) {
  if (!userId) return;
  const db = await getDB();
  const payload = {
    items: Array.isArray(items) ? items : [],
    updatedAt: Date.now(),
  };
  await db.put(STORE_CARTS, payload, String(userId));
}

export async function loadCart(userId) {
  if (!userId) return [];
  const db = await getDB();
  const entry = await db.get(STORE_CARTS, String(userId));
  if (!entry) return [];
  try {
    if (Date.now() - (entry.updatedAt || 0) > CART_TTL_MS) {
      await db.delete(STORE_CARTS, String(userId));
      return [];
    }
  } catch {}
  return Array.isArray(entry.items) ? entry.items : [];
}

export async function clearCart(userId) {
  if (!userId) return;
  const db = await getDB();
  try { await db.delete(STORE_CARTS, String(userId)); } catch {}
}
