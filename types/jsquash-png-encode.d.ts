// gbrain passes a plain { data, width, height } pixel buffer, which the
// package's DOM `ImageData` signature rejects once the DOM lib (needed for
// RequestInfo/BodyInit/HeadersInit) requires `colorSpace`. Mapped via
// tsconfig `paths`; runtime resolution is unchanged.
export default function encode(
  data: { data: Uint8ClampedArray | Uint16Array; width: number; height: number },
  options?: Record<string, unknown>,
): Promise<ArrayBuffer>;
