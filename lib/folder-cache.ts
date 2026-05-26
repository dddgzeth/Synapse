/**
 * Folder handle cache via IndexedDB.
 *
 * Keys are namespaced by userId ("userId:folderName") so each user sees
 * only their own connected folders — essential for multi-user isolation.
 *
 * FileSystemDirectoryHandle survives structured-clone, so we can persist it
 * across page reloads. On restore we still need to re-check the permission
 * (browsers downgrade the grant after the tab closes) and possibly ask the
 * user to re-authorize via a click.
 *
 * Browser-only — caller must guard against SSR.
 */

const DB_NAME = "synapse_folders";
const DB_VERSION = 1;
const STORE = "handles";

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

function userKey(userId: string, name: string) {
  return `${userId}:${name}`;
}

export interface CachedFolder {
  name: string;
  handle: FileSystemDirectoryHandle;
}

export async function saveFolderHandle(
  userId: string,
  name: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, userKey(userId, name));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadFolderHandles(userId: string): Promise<CachedFolder[]> {
  const db = await openDb();
  const prefix = `${userId}:`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    let keys: string[] = [];
    let vals: FileSystemDirectoryHandle[] = [];
    keysReq.onsuccess = () => { keys = keysReq.result as string[]; };
    valsReq.onsuccess = () => { vals = valsReq.result as FileSystemDirectoryHandle[]; };
    tx.oncomplete = () => {
      const out: CachedFolder[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (keys[i]?.startsWith(prefix) && vals[i]) {
          out.push({ name: keys[i].slice(prefix.length), handle: vals[i] });
        }
      }
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeFolderHandle(userId: string, name: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(userKey(userId, name));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Query (no user gesture required) whether the page still has permission.
 * Returns "granted" | "prompt" | "denied".
 */
export async function queryReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  // @ts-expect-error — typings lag the spec
  const status = await handle.queryPermission({ mode: "read" });
  return status as PermissionState;
}

/**
 * Re-request permission. MUST be called from a user gesture (click handler).
 */
export async function requestReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  // @ts-expect-error — typings lag the spec
  const status = await handle.requestPermission({ mode: "read" });
  return status as PermissionState;
}
