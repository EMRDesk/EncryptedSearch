export type Mode = "blindIndex" | "decryptScan" | "clientCache" | "plaintextIndex";

export type BenchmarkBreakdown = {
  indexMs: number;
  fetchMs: number;
  decryptMs: number;
  scanMs: number;
  cacheBuildMs?: number;
};

export type BenchmarkResult = {
  mode: Mode;
  totalMs: number;
  breakdown: BenchmarkBreakdown;
  resultCount: number;
  sampleNote?: string;
  hits?: PersonRecord[];
};

export type PersonRecord = {
  id: string;
  name: string;
  email: string;
  city: string;
  company: string;
};

export type CachedDataset = {
  datasetId: string;
  records: PersonRecord[];
  builtAt: number;
  recordCount: number;
  cap: number;
  buildMs?: number;
};
