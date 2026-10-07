// Bun imports these as text or asset paths; gbrain's sources rely on that.
declare module '*.md' {
  const text: string;
  export default text;
}

declare module '*.wasm' {
  const asset: string;
  export default asset;
}

declare module 'heic-decode';

declare module '*/LICENSE' {
  const text: string;
  export default text;
}

// gbrain imports JSONL fixtures `with { type: 'file' }`; Bun resolves them to an asset path.
declare module '*.jsonl' {
  const asset: string;
  export default asset;
}

// gbrain calls `process.threadCpuUsage` (Node 23.9+, Bun 1.4), which the hoisted @types/node 18 lacks.
declare namespace NodeJS {
  interface Process {
    threadCpuUsage(previousValue?: CpuUsage): CpuUsage;
  }
}
