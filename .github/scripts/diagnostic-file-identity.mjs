import { execFileSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Node 22 Windows lstat can report dev=0 while fstat reports the real volume.
// Do NOT drop the device comparison: obtain it from a no-follow Win32 handle.
export function checkedWindowsIdentity(info, native) {
  const invalid = () => { throw Error('PRIVATE_DIAGNOSTIC_WINDOWS_IDENTITY_INVALID'); };
  for (const key of ['dev', 'ino', 'nlink']) {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(native?.[key] ?? '') || BigInt(native[key]) > 0xffffffffffffffffn) invalid();
  }
  const dev = BigInt(native.dev), ino = BigInt(native.ino), nlink = BigInt(native.nlink);
  if (dev > 0xffffffffn || ino === 0n || info.ino !== ino || info.nlink !== nlink ||
      (info.dev !== 0n && info.dev !== dev) || native.reparse !== false ||
      typeof native.directory !== 'boolean' || native.directory !== info.isDirectory() ||
      info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) invalid();
  return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { dev });
}
export async function diagnosticLstat(path) {
  const info = await lstat(path, { bigint: true });
  if (process.platform !== 'win32' || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return info;
  let native;
  try {
    native = JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./windows-file-identity.ps1', import.meta.url))], {
      input: JSON.stringify({ path }), encoding: 'utf8', timeout: 20_000, maxBuffer: 4096,
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }));
  } catch { throw Error('PRIVATE_DIAGNOSTIC_WINDOWS_IDENTITY_UNAVAILABLE'); }
  return checkedWindowsIdentity(info, native);
}
