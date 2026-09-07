export const CSRF_TOKEN_BYTES = 32;
export const CSRF_TOKEN_LENGTH = 43;

// A canonical paddingless base64url encoding of 32 bytes has 43 characters.
// Its final base64 quantum carries four data bits, so the lower two bits must
// be zero. Restricting the final character makes the encoding canonical.
const csrfTokenPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function isValidCSRFToken(value: string): boolean {
  return value.length === CSRF_TOKEN_LENGTH && csrfTokenPattern.test(value);
}
