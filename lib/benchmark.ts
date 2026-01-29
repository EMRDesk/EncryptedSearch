import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where
} from "firebase/firestore";
import { db } from "./firebase";
import {
  DEFAULT_KDF,
  PQ_KDF,
  computeToken,
  decryptJson,
  encodePrefixDocId,
  getSalt,
  normalize,
  prefixes,
  deriveKeys
} from "./crypto";
import { getCachedDataset, searchCache, setCachedDataset } from "./cache";
import { chunk, now } from "./utils";
import type { BenchmarkResult, Mode, PersonRecord } from "./types";

const CACHE_CAP = 10_000;
const MAX_HITS = 20;
const FULL_SCAN_PAGE_SIZE = 1000;
const MAX_RESULT_FETCH = 50;

const DATASET_SIZES: Record<string, number> = {
  "people-1k": 1_000,
  "people-10k": 10_000,
  "people-100k": 100_000
};

const getDatasetSize = (datasetId: string): number => DATASET_SIZES[datasetId] ?? 1_000;

const fetchRecordsByIds = async (datasetId: string, recordIds: string[]) => {
  const docs: { id: string; ct: string; iv: string }[] = [];
  const start = now();
  for (const group of chunk(recordIds, 10)) {
    const recordsQuery = query(
      collection(db, `datasets/${datasetId}/records`),
      where(documentId(), "in", group)
    );
    const snapshot = await getDocs(recordsQuery);
    snapshot.forEach(docSnap => {
      const data = docSnap.data() as { ct: string; iv: string };
      docs.push({ id: docSnap.id, ct: data.ct, iv: data.iv });
    });
  }
  const fetchMs = now() - start;
  return { docs, fetchMs };
};

const fetchRecordPage = async (datasetId: string, pageSize: number) => {
  const start = now();
  const pageQuery = query(
    collection(db, `datasets/${datasetId}/records`),
    orderBy(documentId()),
    limit(pageSize)
  );
  const snapshot = await getDocs(pageQuery);
  const docs: { id: string; ct: string; iv: string }[] = [];
  snapshot.forEach(docSnap => {
    const data = docSnap.data() as { ct: string; iv: string };
    docs.push({ id: docSnap.id, ct: data.ct, iv: data.iv });
  });
  const fetchMs = now() - start;
  return { docs, fetchMs };
};

const decryptRecords = async (
  docs: { id: string; ct: string; iv: string }[],
  encKey: CryptoKey
) => {
  const start = now();
  const records: PersonRecord[] = [];
  for (const doc of docs) {
    const payload = await decryptJson<PersonRecord>(doc.ct, doc.iv, encKey);
    records.push({ ...payload, id: doc.id });
  }
  const decryptMs = now() - start;
  return { records, decryptMs };
};

const scanRecords = (records: PersonRecord[], normalizedQuery: string) => {
  const start = now();
  const matches = records.filter(record => {
    const name = normalize(record.name);
    const email = normalize(record.email);
    return name.startsWith(normalizedQuery) || email.startsWith(normalizedQuery);
  });
  const scanMs = now() - start;
  return { matches, scanMs };
};

const fetchAllRecords = async (datasetId: string, pageSize: number) => {
  const start = now();
  const docs: { id: string; ct: string; iv: string }[] = [];
  let lastId: string | undefined;

  while (true) {
    const baseQuery = query(
      collection(db, `datasets/${datasetId}/records`),
      orderBy(documentId()),
      limit(pageSize)
    );
    const pageQuery = lastId
      ? query(
          collection(db, `datasets/${datasetId}/records`),
          orderBy(documentId()),
          startAfter(lastId),
          limit(pageSize)
        )
      : baseQuery;
    const snapshot = await getDocs(pageQuery);
    snapshot.forEach(docSnap => {
      const data = docSnap.data() as { ct: string; iv: string };
      docs.push({ id: docSnap.id, ct: data.ct, iv: data.iv });
    });
    if (snapshot.docs.length < pageSize) {
      break;
    }
    lastId = snapshot.docs[snapshot.docs.length - 1]?.id;
    if (!lastId) {
      break;
    }
  }

  const fetchMs = now() - start;
  return { docs, fetchMs };
};

export const runBenchmark = async (options: {
  datasetId: string;
  query: string;
  modes: Mode[];
  passphrase: string;
  pqMode?: boolean;
}): Promise<BenchmarkResult[]> => {
  const { datasetId, query: rawQuery, modes, passphrase, pqMode = false } = options;
  const normalizedQuery = normalize(rawQuery);
  if (!normalizedQuery) {
    return [];
  }

  const salt = getSalt();
  const kdf = pqMode ? PQ_KDF : DEFAULT_KDF;
  const { encKey, indexKey } = await deriveKeys(passphrase, salt, kdf);

  const results: BenchmarkResult[] = [];

  for (const mode of modes) {
    if (mode === "blindIndex") {
      const indexStart = now();
      const token = await computeToken(normalizedQuery, indexKey);
      const indexDoc = await getDoc(doc(db, `datasets/${datasetId}/index/${token}`));
      const indexMs = now() - indexStart;
      const recordIds = (indexDoc.data()?.recordIds as string[]) ?? [];
      const totalCount = recordIds.length;
      const cappedIds =
        totalCount > MAX_RESULT_FETCH ? recordIds.slice(0, MAX_RESULT_FETCH) : recordIds;
      const sampleNote =
        totalCount > MAX_RESULT_FETCH
          ? `Fetched first ${MAX_RESULT_FETCH.toLocaleString()} of ${totalCount.toLocaleString()} matches due to synthetic data repetition.`
          : undefined;

      const { docs, fetchMs } = await fetchRecordsByIds(datasetId, cappedIds);
      const { records, decryptMs } = await decryptRecords(docs, encKey);

      results.push({
        mode,
        totalMs: indexMs + fetchMs + decryptMs,
        breakdown: {
          indexMs,
          fetchMs,
          decryptMs,
          scanMs: 0
        },
        resultCount: totalCount,
        sampleNote,
        hits: records.slice(0, MAX_HITS)
      });
      continue;
    }

    if (mode === "plaintextIndex") {
      const indexStart = now();
      const docId = encodePrefixDocId(normalizedQuery);
      const prefixDoc = await getDoc(
        doc(db, `datasets/${datasetId}/plaintextIndex/${docId}`)
      );
      const indexMs = now() - indexStart;
      const recordIds = (prefixDoc.data()?.recordIds as string[]) ?? [];
      const totalCount = recordIds.length;
      const cappedIds =
        totalCount > MAX_RESULT_FETCH ? recordIds.slice(0, MAX_RESULT_FETCH) : recordIds;
      const sampleNote =
        totalCount > MAX_RESULT_FETCH
          ? `Fetched first ${MAX_RESULT_FETCH.toLocaleString()} of ${totalCount.toLocaleString()} matches due to synthetic data repetition.`
          : undefined;

      const { docs, fetchMs } = await fetchRecordsByIds(datasetId, cappedIds);
      const { records, decryptMs } = await decryptRecords(docs, encKey);

      results.push({
        mode,
        totalMs: indexMs + fetchMs + decryptMs,
        breakdown: {
          indexMs,
          fetchMs,
          decryptMs,
          scanMs: 0
        },
        resultCount: totalCount,
        sampleNote,
        hits: records.slice(0, MAX_HITS)
      });
      continue;
    }

    if (mode === "decryptScan") {
      const { docs, fetchMs } = await fetchAllRecords(datasetId, FULL_SCAN_PAGE_SIZE);
      const { records, decryptMs } = await decryptRecords(docs, encKey);
      const { matches, scanMs } = scanRecords(records, normalizedQuery);

      results.push({
        mode,
        totalMs: fetchMs + decryptMs + scanMs,
        breakdown: {
          indexMs: 0,
          fetchMs,
          decryptMs,
          scanMs
        },
        resultCount: matches.length,
        hits: matches.slice(0, MAX_HITS)
      });
      continue;
    }

    if (mode === "clientCache") {
      const datasetSize = getDatasetSize(datasetId);
      const cacheReadStart = now();
      const cached = await getCachedDataset(datasetId);
      const cacheReadMs = now() - cacheReadStart;
      let cacheBuildMs: number | undefined;
      let fetchMs = 0;
      let decryptMs = 0;
      let records: PersonRecord[] = [];
      let sampleNote: string | undefined;

      if (!cached) {
        const cacheStart = now();
        const { docs, fetchMs: fetched } = await fetchRecordPage(
          datasetId,
          Math.min(datasetSize, CACHE_CAP)
        );
        fetchMs = fetched;
        const { records: decrypted, decryptMs: decMs } = await decryptRecords(docs, encKey);
        decryptMs = decMs;
        cacheBuildMs = now() - cacheStart;
        records = decrypted;
        await setCachedDataset({
          datasetId,
          records,
          builtAt: Date.now(),
          recordCount: records.length,
          cap: CACHE_CAP,
          buildMs: cacheBuildMs
        });
        if (datasetSize > CACHE_CAP) {
          sampleNote = `Cache capped at ${CACHE_CAP.toLocaleString()} records.`;
        }
      } else {
        records = cached.records;
        cacheBuildMs = cached.buildMs;
        if (datasetSize > cached.recordCount) {
          sampleNote = `Cache has ${cached.recordCount.toLocaleString()} records from a larger dataset.`;
        }
      }

      const scanStart = now();
      const matches = searchCache(records, normalizedQuery);
      const scanMs = now() - scanStart;
      if (cached) {
        fetchMs = cacheReadMs;
      }
      const totalMs = cached ? cacheReadMs + scanMs : (cacheBuildMs ?? 0) + scanMs;

      results.push({
        mode,
        totalMs,
        breakdown: {
          indexMs: 0,
          fetchMs,
          decryptMs,
          scanMs,
          cacheBuildMs
        },
        resultCount: matches.length,
        sampleNote,
        hits: matches.slice(0, MAX_HITS)
      });
      continue;
    }
  }

  return results;
};

export const buildBlindIndexTokens = async (
  record: PersonRecord,
  indexKey: CryptoKey
): Promise<string[]> => {
  const fields = [record.name, record.email];
  const tokenSet = new Set<string>();
  for (const field of fields) {
    for (const prefix of prefixes(field)) {
      const token = await computeToken(prefix, indexKey);
      tokenSet.add(token);
    }
  }
  return Array.from(tokenSet);
};
