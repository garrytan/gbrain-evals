import { describe, test, expect } from 'bun:test';
import { _cosine } from './vector.ts';

// Note: VectorOnlyAdapter.init/query require a live embedding API key.
// Those end-to-end tests live in a smoke-test class and gate on OPENAI_API_KEY.
// Here we unit-test the pure-function pieces.

describe('vector adapter (pure helpers)', () => {
  test('cosine of identical vectors = 1.0', () => {
    const a = new Float32Array([1, 2, 3, 4]);
    const b = new Float32Array([1, 2, 3, 4]);
    expect(_cosine(a, b)).toBeCloseTo(1.0, 6);
  });

  test('cosine of opposite vectors = -1.0', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(_cosine(a, b)).toBeCloseTo(-1.0, 6);
  });

  test('cosine of orthogonal vectors = 0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(_cosine(a, b)).toBeCloseTo(0.0, 6);
  });

  test('cosine handles zero vector by returning 0', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(_cosine(a, b)).toBe(0);
  });

  test('cosine is scale-invariant', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]);
    // Same direction, different magnitudes; cosine should still be 1.
    expect(_cosine(a, b)).toBeCloseTo(1.0, 6);
  });

  test('cosine THROWS on mismatched-length vectors (no silent truncation)', () => {
    // Regression for audit adapters-queries-08: the old implementation
    // compared over min(len), so mismatched embedding spaces produced
    // plausible-looking similarities instead of an error. A dim mismatch
    // means the query and doc vectors came from different gateway configs;
    // the only honest behavior is to fail loud.
    const a = new Float32Array([1, 1, 1]);
    const b = new Float32Array([1, 1]);
    expect(() => _cosine(a, b)).toThrow(/dimension mismatch \(3 vs 2\)/);
  });

  test('cosine still works on equal-length vectors after the mismatch guard', () => {
    const a = new Float32Array([1, 1, 1]);
    const b = new Float32Array([1, 1, 1]);
    expect(_cosine(a, b)).toBeCloseTo(1.0, 6);
  });
});
