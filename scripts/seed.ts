import "dotenv/config";
import admin from "firebase-admin";
import { webcrypto } from "crypto";
import { DEFAULT_KDF, PQ_KDF, computeToken, encryptJson, prefixes, deriveKeys } from "../lib/crypto";
import type { PersonRecord } from "../lib/types";

if (!globalThis.crypto) {
  // eslint-disable-next-line no-global-assign
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

const projectId = process.env.FIREBASE_PROJECT_ID;
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!projectId) {
  throw new Error("Missing FIREBASE_PROJECT_ID in environment.");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: serviceAccountJson
      ? admin.credential.cert(JSON.parse(serviceAccountJson))
      : admin.credential.applicationDefault(),
    projectId
  });
}

const db = admin.firestore();

const passphrase = process.env.SEED_PASSPHRASE || "demo-passphrase";
const pqMode = ["1", "true", "yes"].includes((process.env.SEED_PQ_MODE || "").toLowerCase());
const salt = new TextEncoder().encode(
  process.env.KDF_SALT || "encrypted-search-demo-salt"
);

const DATASETS = [
  { id: "people-1k", count: 1_000 },
  { id: "people-10k", count: 10_000 },
  { id: "people-100k", count: 100_000 }
];

const selectedDatasetIds = (process.env.SEED_DATASETS || "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

const datasetsToSeed = selectedDatasetIds.length
  ? DATASETS.filter(dataset => selectedDatasetIds.includes(dataset.id))
  : DATASETS;

const FIRST_NAMES = [
  "Avery",
  "Blake",
  "Cameron",
  "Dakota",
  "Elliot",
  "Finley",
  "Harper",
  "Jordan",
  "Kai",
  "Logan",
  "Morgan",
  "Parker",
  "Quinn",
  "Riley",
  "Sawyer",
  "Skyler",
  "Taylor",
  "Rowan",
  "Remy",
  "Sage"
];

const LAST_NAMES = [
  "Adler",
  "Bennett",
  "Carver",
  "Donovan",
  "Ellis",
  "Fletcher",
  "Gibson",
  "Hayes",
  "Iverson",
  "Jennings",
  "Keller",
  "Lennon",
  "Mercer",
  "North",
  "Prescott",
  "Quincy",
  "Reed",
  "Sinclair",
  "Tatum",
  "Winslow"
];

const CITIES = [
  "Seattle",
  "Austin",
  "Brooklyn",
  "Denver",
  "Raleigh",
  "Portland",
  "Miami",
  "Nashville",
  "Chicago",
  "Boston"
];

const COMPANIES = [
  "Orion Labs",
  "Juniper Systems",
  "Harbor AI",
  "Northwind",
  "Atlas Signal",
  "Silverline",
  "Vertex Capital",
  "LumenWorks",
  "Nova Health",
  "Vantage"
];

const DOMAINS = ["example.com", "mailbox.test", "demo.net", "labs.io"];

const pick = <T,>(list: T[], seed: number) => list[seed % list.length];

const createPerson = (index: number): Omit<PersonRecord, "id"> => {
  const first = pick(FIRST_NAMES, index * 7 + 3);
  const last = pick(LAST_NAMES, index * 11 + 5);
  const city = pick(CITIES, index * 13 + 1);
  const company = pick(COMPANIES, index * 17 + 9);
  const domain = pick(DOMAINS, index * 19 + 2);
  const email = `${first}.${last}${index}@${domain}`.toLowerCase();
  return {
    name: `${first} ${last}`,
    email,
    city,
    company
  };
};

const flushBatches = async (
  recordWrites: Array<{ ref: admin.firestore.DocumentReference; data: unknown }>,
  indexUpdates: Map<string, string[]>,
  plaintextUpdates: Map<string, string[]>,
  datasetId: string
) => {
  const FieldValue = admin.firestore.FieldValue;

  let batch = db.batch();
  let opCount = 0;

  const commitBatch = async () => {
    if (opCount === 0) return;
    await batch.commit();
    batch = db.batch();
    opCount = 0;
  };

  for (const item of recordWrites) {
    batch.set(item.ref, item.data, { merge: true });
    opCount += 1;
    if (opCount >= 450) {
      await commitBatch();
    }
  }

  await commitBatch();

  const queueIndex = async (
    collectionName: string,
    updates: Map<string, string[]>,
    includePrefixField: boolean
  ) => {
    let batchLocal = db.batch();
    let batchCount = 0;

    const commitLocal = async () => {
      if (batchCount === 0) return;
      await batchLocal.commit();
      batchLocal = db.batch();
      batchCount = 0;
    };

    for (const [key, ids] of updates.entries()) {
      const ref = db.doc(`datasets/${datasetId}/${collectionName}/${key}`);
      const data = includePrefixField
        ? { recordIds: FieldValue.arrayUnion(...ids), prefix: key }
        : { recordIds: FieldValue.arrayUnion(...ids) };
      batchLocal.set(ref, data, { merge: true });
      batchCount += 1;
      if (batchCount >= 450) {
        await commitLocal();
      }
    }

    await commitLocal();
  };

  await queueIndex("index", indexUpdates, false);
  await queueIndex("plaintextIndex", plaintextUpdates, true);
};

const seedDataset = async (datasetId: string, count: number) => {
  console.log(`Seeding ${datasetId} with ${count.toLocaleString()} records...`);

  await db.doc(`datasets/${datasetId}`).set(
    {
      id: datasetId,
      size: count,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  const { encKey, indexKey } = await deriveKeys(passphrase, salt, pqMode ? PQ_KDF : DEFAULT_KDF);

  const recordWrites: Array<{ ref: admin.firestore.DocumentReference; data: unknown }> = [];
  const indexUpdates = new Map<string, string[]>();
  const plaintextUpdates = new Map<string, string[]>();

  const append = (map: Map<string, string[]>, key: string, recordId: string) => {
    const list = map.get(key) ?? [];
    list.push(recordId);
    map.set(key, list);
  };

  const flushIfNeeded = async (currentIndex: number) => {
    if (currentIndex % 250 === 0 && recordWrites.length > 0) {
      await flushBatches(recordWrites, indexUpdates, plaintextUpdates, datasetId);
      recordWrites.length = 0;
      indexUpdates.clear();
      plaintextUpdates.clear();
    }
  };

  for (let i = 0; i < count; i += 1) {
    const ref = db.collection(`datasets/${datasetId}/records`).doc();
    const person = createPerson(i);
    const record: PersonRecord = { id: ref.id, ...person };

    const { ct, iv } = await encryptJson(record, encKey);
    recordWrites.push({ ref, data: { ct, iv, v: 1 } });

    const searchPrefixes = new Set([...prefixes(record.name), ...prefixes(record.email)]);
    for (const prefix of searchPrefixes) {
      const token = await computeToken(prefix, indexKey);
      append(indexUpdates, token, ref.id);
      append(plaintextUpdates, prefix, ref.id);
    }

    if (i > 0 && i % 1000 === 0) {
      console.log(`  processed ${i.toLocaleString()} records`);
    }

    await flushIfNeeded(i + 1);
  }

  if (recordWrites.length) {
    await flushBatches(recordWrites, indexUpdates, plaintextUpdates, datasetId);
  }

  console.log(`Finished ${datasetId}.`);
};

const run = async () => {
  for (const dataset of datasetsToSeed) {
    await seedDataset(dataset.id, dataset.count);
  }
  console.log("All datasets seeded.");
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
