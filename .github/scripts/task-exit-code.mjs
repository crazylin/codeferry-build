/** Retain Windows 32-bit termination statuses without copying child text. */
export function diagnosticExitCode(code, platform = process.platform) {
  if (!Number.isInteger(code)) return 'none';
  if (platform === 'win32') return code >= -0x80000000 && code <= 0xffffffff ? code >>> 0 : 'none';
  return code >= 0 && code <= 255 ? code : 'none';
}
