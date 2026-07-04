declare module 'pako' {
  export function ungzip(input: Uint8Array, options?: { to?: 'string' }): string | Uint8Array;
}
