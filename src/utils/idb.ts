/**
 * Minimal IndexedDB promise wrapper — P3 wires this into the result cache.
 */

export function openDB(name: string, version = 1): Promise<IDBDatabase> {
  return new Promise((resolveP, reject) => {
    const req = indexedDB.open(name, version);
    req.onsuccess = () => resolveP(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}
