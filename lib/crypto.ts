const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type KdfOptions = {
  iterations: number;
  hmacHash: "SHA-256" | "SHA-512";
};

export const DEFAULT_KDF: KdfOptions = {
  iterations: 100_000,
  hmacHash: "SHA-256"
};

export const PQ_KDF: KdfOptions = {
  iterations: 300_000,
  hmacHash: "SHA-512"
};

export const normalize = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

export const prefixes = (value: string, maxLen = 20): string[] => {
  const norm = normalize(value);
  const cap = Math.min(maxLen, norm.length);
  const out: string[] = [];
  for (let i = 1; i <= cap; i += 1) {
    out.push(norm.slice(0, i));
  }
  return out;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const bytesToBase64Url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const base64UrlToBytes = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (value.length % 4)) % 4);
  return base64ToBytes(padded);
};

export const getSalt = (): Uint8Array => {
  const salt = process.env.NEXT_PUBLIC_KDF_SALT || "encrypted-search-demo-salt";
  return textEncoder.encode(salt);
};

export const deriveKeys = async (
  passphrase: string,
  salt: Uint8Array,
  options: KdfOptions
): Promise<{ encKey: CryptoKey; indexKey: CryptoKey }> => {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: options.iterations,
      hash: "SHA-256"
    },
    baseKey,
    512
  );

  const bytes = new Uint8Array(bits);
  const encKeyBytes = bytes.slice(0, 32);
  const indexKeyBytes = bytes.slice(32, 64);

  const encKey = await crypto.subtle.importKey("raw", encKeyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt"
  ]);

  const indexKey = await crypto.subtle.importKey(
    "raw",
    indexKeyBytes,
    {
      name: "HMAC",
      hash: options.hmacHash
    },
    false,
    ["sign"]
  );

  return { encKey, indexKey };
};

export const encryptJson = async (
  payload: unknown,
  encKey: CryptoKey
): Promise<{ ct: string; iv: string }> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encKey, plaintext);
  return {
    ct: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv)
  };
};

export const decryptJson = async <T>(
  ct: string,
  iv: string,
  encKey: CryptoKey
): Promise<T> => {
  const ciphertext = base64ToBytes(ct);
  const ivBytes = base64ToBytes(iv);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, encKey, ciphertext);
  return JSON.parse(textDecoder.decode(plaintext)) as T;
};

export const computeToken = async (
  normalizedQuery: string,
  indexKey: CryptoKey
): Promise<string> => {
  const data = textEncoder.encode(normalizedQuery);
  const signature = await crypto.subtle.sign("HMAC", indexKey, data);
  return bytesToBase64Url(new Uint8Array(signature));
};

export const encodePrefixDocId = (prefixValue: string): string => prefixValue;

export const decodePrefixDocId = (prefixValue: string): string => prefixValue;

export const decodeBase64Url = (value: string): Uint8Array => base64UrlToBytes(value);
