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
