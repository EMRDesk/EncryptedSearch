# Encrypted Search Benchmark

A Next.js + Firestore demo that compares four searchable-encryption modes side-by-side, with a dark, minimal UI and post-quantum-friendly symmetric crypto choices.

## What this demo does

- Runs the same prefix search across four modes:
  - **A. Blind Index**: HMAC token lookup + encrypted record fetch + client decrypt.
- **B. Decrypt-and-Scan**: fetch the full dataset, decrypt, prefix scan locally (slow).
  - **C. Client Cache**: build IndexedDB cache, then local prefix search (shows cold + warm).
  - **D. Plaintext Index**: control mode with plaintext prefixes stored in Firestore (violates zero-trust).
- Shows total latency + breakdown (index, fetch, decrypt, scan, cache build).
- Displays a latency bar chart and top decrypted hits per mode (up to 20).

## Post-quantum notes (required copy)

- Symmetric crypto at 256-bit is considered **post-quantum robust** in practice because Grover’s algorithm provides at most a quadratic speedup, so AES-256/HMAC with 256-bit keys retain a strong security margin.
- This demo **is not** a PQ key exchange demo; it assumes the client already has the secret passphrase.
- The major remaining risk is **leakage inherent to deterministic searchable encryption** (equality/frequency/access patterns), not “quantum breaking” of AES/HMAC.

## Firestore data model

```
datasets/{datasetId}
  size: number
  updatedAt: timestamp

datasets/{datasetId}/records/{recordId}
  { ct, iv, v }

datasets/{datasetId}/index/{token}
  { recordIds }

datasets/{datasetId}/plaintextIndex/{prefixDocId}
  { prefix, recordIds }
```

## Crypto choices

- AES-256-GCM for encryption
- HMAC-SHA-256 tokens (or HMAC-SHA-512 in PQ mode)
- PBKDF2-SHA-256, 100k iterations (300k in PQ mode)
- 64-byte KDF output split into:
  - first 32 bytes => encKey
  - second 32 bytes => indexKey

## Requirements

- Node 18+ (for WebCrypto)
- Firestore project with read-only client rules

## Environment variables

Create `.env.local` for the Next.js app:

```
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
NEXT_PUBLIC_KDF_SALT=encrypted-search-demo-salt
NEXT_PUBLIC_DEMO_PASSPHRASE=demo-passphrase
```

Create `.env` (or reuse `.env.local`) for seeding:

```
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
SEED_PASSPHRASE=demo-passphrase
KDF_SALT=encrypted-search-demo-salt
# optional: seed with PQ-mode parameters so HMAC-SHA-512 tokens match
SEED_PQ_MODE=true
# optional: limit seeding to certain datasets
SEED_DATASETS=people-1k,people-10k
```

## Seeding Firestore

```
npm install
npm run seed
```

This generates synthetic people records and writes:
- encrypted records
- blind index tokens
- plaintext prefix index (Mode D)

Seeding the 100k dataset can take time and uses many writes.
If you toggle PQ mode in the UI, seed with `SEED_PQ_MODE=true` so blind-index tokens match.

## Running locally

```
npm run dev
```

Open `http://localhost:3000`.

## Firestore rules (read-only clients)

A sample rule set is provided in `firestore.rules` to allow client reads only. Use admin/service credentials for seeding.

If you currently have a deny-all rule, update to this read-only set so the demo UI can read:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /datasets/{datasetId} {
      allow read: if true;
      allow write: if false;

      match /{subcollection}/{docId} {
        allow read: if true;
        allow write: if false;
      }
    }
  }
}
```

## Disclaimers

- Blind indexing leaks equality/frequency/access patterns.
- Mode D violates zero-trust by storing plaintext prefixes.
- Mode C caches decrypted records in IndexedDB on the client.
- Mode B is computationally expensive and not scalable for large datasets.
- Modes A/D cap fetched matches in the demo due to synthetic data repetition.

## Deployment

## Hosting (Vercel)

This app is a static Next.js client with Firestore reads. No Functions are required.

1. Create a new Vercel project connected to this repo.
2. Add environment variables (Project Settings → Environment Variables):
   - `NEXT_PUBLIC_FIREBASE_API_KEY`
   - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
   - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
   - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
   - `NEXT_PUBLIC_FIREBASE_APP_ID`
   - `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` (optional)
   - `NEXT_PUBLIC_KDF_SALT`
   - `NEXT_PUBLIC_DEMO_PASSPHRASE`
3. Deploy.

Notes:
- Do **not** upload the service account JSON to Vercel. Seeding is a local/admin task.
- Keep Firestore rules read-only for clients.
- If you enable PQ mode in the UI, seed with `SEED_PQ_MODE=true` so tokens match.
