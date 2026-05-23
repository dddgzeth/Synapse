/**
 * IndexedDB cache for parsed PDF text.
 *
 * Key: `${path}@${lastModified}` so file edits invalidate naturally.
 * Old entries for the same path remain in DB but won't match new mtime;
 * we GC them lazily on read miss.
 */

const DB_NAME = "synapse_pdf_cache";
const DB_VERSION = 1;
const STORE = "parsed";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function key(path: string, mtime: number): string {
  return `${path}@${mtime}`;
}

export async function getCachedPdfText(path: string, mtime: number): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key(path, mtime));
    req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
    req.onerror = () => reject(req.error);
  });
}

export async function putCachedPdfText(path: string, mtime: number, text: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(text, key(path, mtime));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
