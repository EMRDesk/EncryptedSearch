"use client";

import { useMemo, useRef, useState } from "react";
import { runBenchmark } from "../lib/benchmark";
import type { BenchmarkResult, Mode } from "../lib/types";

const DATASETS = [
  { id: "people-1k", label: "1k", size: 1_000 },
  { id: "people-10k", label: "10k", size: 10_000 },
  { id: "people-100k", label: "100k", size: 100_000 }
];

const MODE_META: Record<Mode, { label: string; description: string; tag: string }> = {
  blindIndex: {
    label: "A. Blind Index",
    description: "HMAC token lookup, encrypted records only.",
    tag: "Zero-trust aligned"
  },
  decryptScan: {
    label: "B. Decrypt-and-Scan",
    description: "Fetch + decrypt the full dataset, prefix match locally.",
    tag: "Naive baseline"
  },
  clientCache: {
    label: "C. Client Cache",
    description: "Warm cache in IndexedDB, local prefix search.",
    tag: "Warm baseline"
  },
  plaintextIndex: {
    label: "D. Plaintext Index",
    description: "Plaintext prefix index, fast control.",
    tag: "Zero-trust violation"
  }
};

const MODE_ORDER: Mode[] = ["blindIndex", "decryptScan", "clientCache", "plaintextIndex"];
const GITHUB_URL =
  process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/EMRDesk/EncryptedSearch";
const AUTHOR_EMAIL = "research@emrdesk.com";
const CSV_HEADER = [
  "timestamp",
  "datasetId",
  "datasetSize",
  "query",
  "mode",
  "totalMs",
  "indexMs",
  "fetchMs",
  "decryptMs",
  "scanMs",
  "cacheBuildMs",
  "resultCount",
  "sampleNote"
].join(",");

const formatMs = (value: number) => `${value.toFixed(1)} ms`;
const escapeCsv = (value: string | number | boolean | null | undefined) =>
  `"${String(value ?? "").replace(/"/g, "\"\"")}"`;

const buildCsvRows = (
  meta: {
    timestamp: string;
    datasetId: string;
    datasetSize: number;
    query: string;
  },
  results: BenchmarkResult[]
) =>
  results.map(result =>
    [
      meta.timestamp,
      meta.datasetId,
      meta.datasetSize,
      meta.query,
      result.mode,
      result.totalMs.toFixed(1),
      result.breakdown.indexMs.toFixed(1),
      result.breakdown.fetchMs.toFixed(1),
      result.breakdown.decryptMs.toFixed(1),
      result.breakdown.scanMs.toFixed(1),
      result.breakdown.cacheBuildMs ? result.breakdown.cacheBuildMs.toFixed(1) : "",
      result.resultCount,
      result.sampleNote ?? ""
    ]
      .map(escapeCsv)
      .join(",")
  );

export default function Home() {
  const [datasetId, setDatasetId] = useState(DATASETS[0].id);
  const [query, setQuery] = useState("an");
  const [selectedModes, setSelectedModes] = useState<Mode[]>([...MODE_ORDER]);
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [autoRuns, setAutoRuns] = useState(20);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoProgress, setAutoProgress] = useState(0);
  const runCountRef = useRef(0);
  const csvLogRef = useRef<string[]>([CSV_HEADER]);
  const [csvLogVersion, setCsvLogVersion] = useState(0);
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactMessage, setContactMessage] = useState("");

  const datasetMeta = DATASETS.find(dataset => dataset.id === datasetId) ?? DATASETS[0];
  const passphrase = process.env.NEXT_PUBLIC_DEMO_PASSPHRASE || "demo-passphrase";

  const reportMeta = useMemo(
    () => ({
      timestamp: new Date().toISOString(),
      datasetId,
      datasetSize: datasetMeta.size,
      query,
      modes: selectedModes
    }),
    [datasetId, datasetMeta.size, query, selectedModes]
  );

  const serializeResults = () =>
    JSON.stringify({ ...reportMeta, results }, null, 2);

  const toCsv = () => {
    const rows = buildCsvRows(reportMeta, results);
    return [CSV_HEADER, ...rows].join("\n");
  };

  const copyText = async (text: string, label: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        window.prompt("Copy to clipboard:", text);
      }
      setCopyNotice(`${label} copied to clipboard.`);
      setTimeout(() => setCopyNotice(null), 2000);
    } catch (err) {
      console.error(err);
      setError("Copy failed. Check browser permissions.");
    }
  };

  const hasCsvLog = csvLogVersion >= 0 && csvLogRef.current.length > 1;

  const appendCsvLog = (
    meta: { timestamp: string; datasetId: string; datasetSize: number; query: string },
    run: BenchmarkResult[]
  ) => {
    const rows = buildCsvRows(meta, run);
    csvLogRef.current.push(...rows);
    setCsvLogVersion(version => version + 1);
    return rows;
  };

  const getCsvLog = () => csvLogRef.current.join("\n");

  const clearCsvLog = () => {
    csvLogRef.current = [CSV_HEADER];
    setCsvLogVersion(version => version + 1);
    if (typeof window !== "undefined") {
      const global = window as Window & { __benchmarkCsv?: string[] };
      global.__benchmarkCsv = [CSV_HEADER];
    }
  };

  const downloadCsvLog = () => {
    const csv = getCsvLog();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "benchmark-log.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const onSendContact = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const subject = `Encrypted Search Benchmark — Contact from ${contactName || "Visitor"}`;
    const body = [
      `Name: ${contactName || "N/A"}`,
      `Email: ${contactEmail || "N/A"}`,
      "",
      contactMessage || ""
    ].join("\n");
    const mailto = `mailto:${AUTHOR_EMAIL}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
  };

  const onToggleMode = (mode: Mode) => {
    setSelectedModes(prev =>
      prev.includes(mode) ? prev.filter(item => item !== mode) : [...prev, mode]
    );
  };

  const runOnce = async (config: {
    datasetId: string;
    datasetSize: number;
    query: string;
    modes: Mode[];
    passphrase: string;
  }) => {
    runCountRef.current += 1;
    const meta = {
      timestamp: new Date().toISOString(),
      datasetId: config.datasetId,
      datasetSize: config.datasetSize,
      query: config.query,
      modes: config.modes
    };
    const run = await runBenchmark({
      datasetId: config.datasetId,
      query: config.query,
      modes: config.modes,
      passphrase: config.passphrase,
      pqMode: false
    });
    setResults(run);
    const payload = {
      run: runCountRef.current,
      ...meta,
      results: run
    };
    const csvRows = appendCsvLog(meta, run);
    const csvRun = [CSV_HEADER, ...csvRows].join("\n");
    console.log("[Benchmark JSON]\\n" + JSON.stringify(payload));
    console.log("[Benchmark CSV]\\n" + csvRun);
    if (typeof window !== "undefined") {
      const global = window as Window & { __benchmarkCsv?: string[] };
      if (!global.__benchmarkCsv) {
        global.__benchmarkCsv = [CSV_HEADER];
      }
      global.__benchmarkCsv.push(...csvRows);
      console.log("[Benchmark CSV LOG]\\n" + global.__benchmarkCsv.join("\n"));
    }
  };

  const onRunBenchmark = async () => {
    setError(null);
    if (!query.trim()) {
      setError("Enter a search prefix to benchmark.");
      return;
    }
    if (selectedModes.length === 0) {
      setError("Pick at least one mode to compare.");
      return;
    }
    const config = {
      datasetId,
      datasetSize: datasetMeta.size,
      query,
      modes: selectedModes,
      passphrase
    };

    setLoading(true);
    try {
      await runOnce(config);
    } catch (err) {
      console.error(err);
      setError("Benchmark failed. Check Firestore config and dataset seeding.");
    } finally {
      setLoading(false);
    }
  };

  const onRunMultiple = async () => {
    setError(null);
    if (!query.trim()) {
      setError("Enter a search prefix to benchmark.");
      return;
    }
    if (selectedModes.length === 0) {
      setError("Pick at least one mode to compare.");
      return;
    }
    const count = Number.isFinite(autoRuns) ? Math.max(1, Math.min(100, autoRuns)) : 1;
    const config = {
      datasetId,
      datasetSize: datasetMeta.size,
      query,
      modes: selectedModes,
      passphrase
    };

    setAutoRunning(true);
    setAutoProgress(0);
    try {
      for (let i = 0; i < count; i += 1) {
        setAutoProgress(i + 1);
        await runOnce(config);
      }
    } catch (err) {
      console.error(err);
      setError("Auto-run failed. Check Firestore config and dataset seeding.");
    } finally {
      setAutoRunning(false);
    }
  };

  const resultsByMode = useMemo(() => {
    const map = new Map(results.map(result => [result.mode, result]));
    return MODE_ORDER.map(mode => map.get(mode)).filter(Boolean) as BenchmarkResult[];
  }, [results]);

  const maxLatency = Math.max(1, ...results.map(result => result.totalMs));
  const isRunning = loading || autoRunning;

  return (
    <main className="min-h-screen px-4 py-16">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-slate-800/60 bg-slate-950/50 p-4">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-slate-400">
              Encrypted Search
            </p>
          </div>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-full border border-slate-700/70 px-3 py-2 text-xs text-slate-200 transition hover:border-slate-400"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-4 w-4 fill-current"
            >
              <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.31 6.84 9.66.5.09.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.62-3.37-1.37-3.37-1.37-.46-1.2-1.12-1.52-1.12-1.52-.92-.64.07-.63.07-.63 1.02.07 1.56 1.07 1.56 1.07.9 1.58 2.36 1.12 2.94.85.09-.67.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.72 0 0 .84-.27 2.75 1.05a9.24 9.24 0 0 1 5 0c1.9-1.32 2.74-1.05 2.74-1.05.56 1.42.21 2.46.1 2.72.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.58.69.48 3.97-1.35 6.84-5.16 6.84-9.66C22 6.58 17.52 2 12 2z" />
            </svg>
            GitHub
          </a>
        </header>

        <section className="space-y-4">
          <p className="text-sm uppercase tracking-[0.3em] text-slate-400">
            Encrypted Search Benchmark
          </p>
          <h1 className="text-4xl font-semibold text-slate-50 md:text-5xl">
            Compare blind indexing against real-world baselines.
          </h1>
          <p className="max-w-3xl text-base text-slate-300 md:text-lg">
            Run the same prefix query across four modes and see where the time goes: index
            lookup, record fetch, decrypt, and scan. Designed for zero-trust demos and
            modern symmetric crypto.
          </p>
        </section>

        <section className="card-sheen rounded-3xl border border-slate-800/60 p-6 shadow-glow">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Dataset</p>
              <p className="text-lg text-slate-100">
                Synthetic people ({datasetMeta.size.toLocaleString()} records)
              </p>
            </div>
              <div className="flex rounded-full border border-slate-700/70 bg-slate-900/60 p-1">
                {DATASETS.map(dataset => (
                  <button
                    key={dataset.id}
                    type="button"
                    onClick={() => setDatasetId(dataset.id)}
                    className={`rounded-full px-4 py-1 text-sm transition ${
                      datasetId === dataset.id
                        ? "bg-slate-100 text-slate-900"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {dataset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-6 grid gap-3">
              <label className="flex flex-col gap-2 text-sm text-slate-300">
                Search prefix
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="e.g. har"
                  className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-base text-slate-100 outline-none transition focus:border-sky-400"
                />
              </label>
              <p className="text-xs text-slate-500">
                Try: annie, harper, taylor, jordan, riley, blake, ellis, sinclair.
              </p>
            </div>

            <div className="mt-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Modes</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {MODE_ORDER.map(mode => (
                  <label
                    key={mode}
                    className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-800/60 bg-slate-950/50 p-4 transition hover:border-slate-600"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-700 bg-slate-900 text-sky-400"
                      checked={selectedModes.includes(mode)}
                      onChange={() => onToggleMode(mode)}
                    />
                    <div>
                      <p className="text-sm font-semibold text-slate-100">
                        {MODE_META[mode].label}
                      </p>
                      <p className="text-xs text-slate-400">{MODE_META[mode].description}</p>
                      <p className="text-[0.7rem] uppercase tracking-[0.18em] text-slate-500">
                        {MODE_META[mode].tag}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
            <button
              type="button"
              onClick={onRunBenchmark}
              disabled={isRunning}
              className="rounded-full bg-sky-400 px-6 py-3 text-sm font-semibold text-slate-900 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Running benchmarks..." : "Run Benchmark"}
            </button>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <label className="flex items-center gap-2">
                Runs
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={autoRuns}
                  onChange={event => setAutoRuns(Number(event.target.value))}
                  className="w-20 rounded-full border border-slate-800 bg-slate-950/60 px-3 py-1 text-xs text-slate-100"
                />
              </label>
              <button
                type="button"
                onClick={onRunMultiple}
                disabled={isRunning}
                className="rounded-full border border-slate-700/70 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {autoRunning ? `Running ${autoProgress}/${autoRuns}` : `Run ${autoRuns}x`}
              </button>
            </div>
            {error ? <p className="text-sm text-rose-400">{error}</p> : null}
          </div>
        </section>

        <section className="card-sheen rounded-3xl border border-slate-800/60 p-6 shadow-glow">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                Benchmark Results
              </p>
              <p className="text-lg text-slate-100">Side-by-side latency breakdown</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={results.length === 0}
                onClick={() => copyText(serializeResults(), "JSON")}
                className="rounded-full border border-slate-700/70 px-4 py-2 text-xs text-slate-200 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Copy JSON
              </button>
              <button
                type="button"
                disabled={results.length === 0}
                onClick={() => copyText(toCsv(), "CSV")}
                className="rounded-full border border-slate-700/70 px-4 py-2 text-xs text-slate-200 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Copy CSV
              </button>
              <button
                type="button"
                disabled={!hasCsvLog}
                onClick={() => copyText(getCsvLog(), "CSV log")}
                className="rounded-full border border-slate-700/70 px-4 py-2 text-xs text-slate-200 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Copy CSV log
              </button>
              <button
                type="button"
                disabled={!hasCsvLog}
                onClick={downloadCsvLog}
                className="rounded-full border border-slate-700/70 px-4 py-2 text-xs text-slate-200 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Download CSV
              </button>
              <button
                type="button"
                disabled={!hasCsvLog}
                onClick={clearCsvLog}
                className="rounded-full border border-slate-700/70 px-4 py-2 text-xs text-slate-200 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear log
              </button>
              <span className="text-xs text-slate-500">Times in milliseconds</span>
            </div>
          </div>
          {copyNotice ? (
            <p className="mt-2 text-xs text-emerald-400">{copyNotice}</p>
          ) : null}

          {results.length === 0 ? (
            <div className="mt-8 rounded-2xl border border-dashed border-slate-800/70 p-8 text-center text-sm text-slate-500">
              Run a benchmark to populate results.
            </div>
          ) : (
            <div className="mt-6 space-y-8">
              <div className="grid gap-4">
                {resultsByMode.map(result => (
                  <div key={result.mode} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-200">{MODE_META[result.mode].label}</span>
                      <span className="font-mono text-slate-100">{formatMs(result.totalMs)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-900">
                      <div
                        className="h-2 rounded-full bg-sky-400"
                        style={{ width: `${(result.totalMs / maxLatency) * 100}%` }}
                      />
                    </div>
                    {result.sampleNote ? (
                      <p className="text-xs text-slate-500">{result.sampleNote}</p>
                    ) : null}
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.2em] text-slate-500">
                    <tr>
                      <th className="py-3 pr-4">Mode</th>
                      <th className="py-3 pr-4">Total</th>
                      <th className="py-3 pr-4">Index</th>
                      <th className="py-3 pr-4">Fetch</th>
                      <th className="py-3 pr-4">Decrypt</th>
                      <th className="py-3 pr-4">Scan</th>
                      <th className="py-3">Cache Build</th>
                    </tr>
                  </thead>
                  <tbody className="text-slate-200">
                    {resultsByMode.map(result => (
                      <tr key={`table-${result.mode}`} className="border-t border-slate-800/60">
                        <td className="py-3 pr-4 text-sm text-slate-100">
                          {MODE_META[result.mode].label}
                        </td>
                        <td className="py-3 pr-4 font-mono">{formatMs(result.totalMs)}</td>
                        <td className="py-3 pr-4 font-mono">{formatMs(result.breakdown.indexMs)}</td>
                        <td className="py-3 pr-4 font-mono">{formatMs(result.breakdown.fetchMs)}</td>
                        <td className="py-3 pr-4 font-mono">
                          {formatMs(result.breakdown.decryptMs)}
                        </td>
                        <td className="py-3 pr-4 font-mono">{formatMs(result.breakdown.scanMs)}</td>
                        <td className="py-3 font-mono">
                          {result.breakdown.cacheBuildMs
                            ? formatMs(result.breakdown.cacheBuildMs)
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                {resultsByMode.map(result => (
                  <div
                    key={`hits-${result.mode}`}
                    className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-4"
                  >
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-100">{MODE_META[result.mode].label}</span>
                      <span className="text-slate-400">
                        {result.resultCount.toLocaleString()} matches
                      </span>
                    </div>
                    <div className="mt-3 overflow-x-auto">
                      <table className="min-w-full text-left text-xs text-slate-300">
                        <thead className="uppercase tracking-[0.2em] text-slate-500">
                          <tr>
                            <th className="py-2 pr-3">Name</th>
                            <th className="py-2 pr-3">Email</th>
                            <th className="py-2">City</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.hits && result.hits.length > 0 ? (
                            result.hits.map(hit => (
                              <tr key={`${result.mode}-${hit.id}`} className="border-t border-slate-800/60">
                                <td className="py-2 pr-3 text-slate-100">{hit.name}</td>
                                <td className="py-2 pr-3 font-mono text-slate-300">{hit.email}</td>
                                <td className="py-2 text-slate-400">{hit.city}</td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={3} className="py-4 text-slate-500">
                                No decrypted hits.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>

            </div>
          )}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-[#f1f1f1] p-6 text-slate-900">
          <div className="grid gap-6 md:grid-cols-[1.2fr_0.8fr] md:items-center">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                Research supported by EMRDesk
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-900">
                Secure search at real-world scale
              </h2>
              <p className="mt-3 text-sm text-slate-600">
                EMRDesk uses the same algorithm in this paper to securely search millions of
                encrypted patient records.
              </p>
            </div>
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white p-6">
              <a href="https://emrdesk.com" target="_blank" rel="noreferrer">
                <img
                  src="/assets/EMRDesk_logo_wide.png"
                  alt="EMRDesk logo"
                  className="h-12 w-auto"
                />
              </a>
              <a
                href="https://emrdesk.com"
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400"
              >
                Learn more
              </a>
            </div>
          </div>
        </section>

        <section className="grid gap-4 text-xs text-slate-400 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-800/60 bg-slate-950/60 p-4">
            <p className="text-slate-300">Security disclaimers</p>
            <ul className="mt-2 space-y-1">
              <li>Blind indexing leaks equality and access patterns.</li>
              <li>Mode D stores plaintext prefixes and violates zero-trust.</li>
              <li>Mode C stores decrypted data in IndexedDB on the client.</li>
              <li>Mode B is expensive and not scalable for large datasets.</li>
              <li>Modes A/D fetch a capped subset when matches explode due to synthetic repetition.</li>
            </ul>
            <div className="mt-4 border-t border-slate-800/60 pt-3">
              <p className="text-slate-300">Paper</p>
              <p className="mt-1 text-xs text-slate-500">
                This demo follows the blind-index searchable encryption approach described in
                the accompanying paper.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-800/60 bg-slate-950/60 p-4">
            <p className="text-slate-300">Crypto parameters</p>
            <ul className="mt-2 space-y-1">
              <li>AES-256-GCM encryption with 96-bit IVs.</li>
              <li>HMAC-SHA-256 tokens (SHA-512 in PQ mode).</li>
              <li>PBKDF2-SHA-256, 100k iterations (300k in PQ mode).</li>
              <li>64-byte KDF output split into encKey + indexKey.</li>
            </ul>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-800/60 bg-slate-950/60 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Contact author</p>
              <p className="text-lg text-slate-100">Share feedback or request details</p>
            </div>
            <p className="text-xs text-slate-500">Emails go to research@emrdesk.com</p>
          </div>
          <form onSubmit={onSendContact} className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              Name
              <input
                value={contactName}
                onChange={event => setContactName(event.target.value)}
                placeholder="Your name"
                className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              Email
              <input
                value={contactEmail}
                onChange={event => setContactEmail(event.target.value)}
                placeholder="you@company.com"
                type="email"
                className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-300 md:col-span-2">
              Message
              <textarea
                value={contactMessage}
                onChange={event => setContactMessage(event.target.value)}
                placeholder="Tell us about your use case or question."
                rows={4}
                className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3 md:col-span-2">
              <button
                type="submit"
                className="rounded-full bg-sky-400 px-5 py-2 text-xs font-semibold text-slate-900 transition hover:bg-sky-300"
              >
                Send email
              </button>
              <button
                type="button"
                onClick={() =>
                  copyText(
                    `Name: ${contactName || "N/A"}\nEmail: ${contactEmail || "N/A"}\n\n${contactMessage}`,
                    "Contact details"
                  )
                }
                className="rounded-full border border-slate-700/70 px-4 py-2 text-xs text-slate-200 transition hover:border-slate-400"
              >
                Copy message
              </button>
            </div>
          </form>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>Encrypted Search · Next.js + Firestore</span>
          <span>Zero-trust demo — not production hardened</span>
        </footer>
      </div>
    </main>
  );
}
