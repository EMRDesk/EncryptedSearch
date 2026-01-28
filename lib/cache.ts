import type { CachedDataset, PersonRecord } from "./types";
import { normalize } from "./crypto";

const DB_NAME = "encrypted-search-cache";
const STORE = "datasets";

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const withStore = async <T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
};

export const getCachedDataset = async (datasetId: string): Promise<CachedDataset | null> => {
  try {
    const result = await withStore("readonly", store => store.get(datasetId));
    return (result as CachedDataset | undefined) ?? null;
  } catch {
    return null;
  }
};

export const setCachedDataset = async (cache: CachedDataset): Promise<void> => {
  await withStore("readwrite", store => store.put(cache, cache.datasetId));
};

export const clearCachedDataset = async (datasetId: string): Promise<void> => {
  await withStore("readwrite", store => store.delete(datasetId));
};

export const searchCache = (
  records: PersonRecord[],
  normalizedQuery: string
): PersonRecord[] =>
  records.filter(record => {
    const name = normalize(record.name);
    const email = normalize(record.email);
    return name.startsWith(normalizedQuery) || email.startsWith(normalizedQuery);
  });
