// Local audio cache (IndexedDB), keyed by YouTube video id. Lets a repeated URL
// skip the backend download. Every failure here is non-fatal: callers treat a
// broken cache as a miss.
const DB_NAME = 'sonora-audio-cache';
const STORE = 'audio';
export const MAX_CACHE_BYTES = 500 * 1024 * 1024;

interface Entry {
  videoId: string;
  data: ArrayBuffer;
  size: number;
  lastAccess: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'videoId' });
      store.createIndex('lastAccess', 'lastAccess');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Returns the cached audio bytes, refreshing its last-access time, or null. */
export async function getCachedAudio(videoId: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const entry = (await wrap(store.get(videoId))) as Entry | undefined;
      if (entry) store.put({ ...entry, lastAccess: Date.now() } satisfies Entry);
      await done(tx);
      return entry?.data ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Stores the audio, then evicts least-recently-used entries beyond the size limit. */
export async function putCachedAudio(videoId: string, data: ArrayBuffer): Promise<void> {
  if (data.byteLength > MAX_CACHE_BYTES) return;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put({ videoId, data, size: data.byteLength, lastAccess: Date.now() } satisfies Entry);

      // Oldest first; the entry just written is the newest and is evicted last.
      let total = 0;
      const entries: { videoId: string; size: number }[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursorReq = store.index('lastAccess').openCursor(null, 'prev');
        cursorReq.onerror = () => reject(cursorReq.error);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          const e = cursor.value as Entry;
          total += e.size;
          if (total > MAX_CACHE_BYTES) entries.push({ videoId: e.videoId, size: e.size });
          cursor.continue();
        };
      });
      for (const e of entries) store.delete(e.videoId);
      await done(tx);
    } finally {
      db.close();
    }
  } catch {
    // quota exceeded or storage unavailable: just skip caching
  }
}
