// What is open (the PDF, the reading position, the settings), kept across the
// reload that switches to a newly deployed version. Stored in IndexedDB,
// which holds a whole PDF where localStorage would not.

export interface Session {
  name: string;
  data: Uint8Array;
  position: { unit: number; char: number };
  options: Record<string, boolean>;
  rate: number;
  voice: string;
  scrollTop: number;
  savedAt: number;
}

const DB = 'read-aloud';
const STORE = 'session';
const KEY = 'pending-update';
/** A session older than this is stale (the update was not carried out). */
const MAX_AGE = 10 * 60 * 1000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = action(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).finally(() => db.close()),
  );
}

export async function saveSession(session: Session): Promise<void> {
  await run('readwrite', (store) => store.put(session, KEY));
}

/** The session saved before the update, once: it is removed as it is read. */
export async function takeSession(): Promise<Session | null> {
  try {
    const session = await run<Session | undefined>('readonly', (store) => store.get(KEY));
    if (!session) return null;
    await run('readwrite', (store) => store.delete(KEY));
    return Date.now() - session.savedAt < MAX_AGE ? session : null;
  } catch {
    return null;
  }
}
