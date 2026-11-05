import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha512 } from '../src/format/sha512';

const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('sha512 murni JS', () => {
  it('vektor standar', () => {
    expect(hex(sha512(new Uint8Array()))).toBe(
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
    );
    expect(hex(sha512(new TextEncoder().encode('abc')))).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
  });

  it('cocok dengan Node crypto untuk berbagai panjang (sekitar batas blok 111/112/127/128)', () => {
    for (const n of [1, 111, 112, 113, 127, 128, 129, 255, 256, 1000, 4097]) {
      const data = new Uint8Array(n).map((_, i) => (i * 97 + 13) & 0xff);
      expect(hex(sha512(data)), `panjang ${n}`).toBe(createHash('sha512').update(data).digest('hex'));
    }
  });
});
