# Read-only native identity; never follow the final reparse point or print paths.
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CodeFerryFileIdentity {
  [StructLayout(LayoutKind.Sequential)]
  public struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  public static Info Read(string path) {
    // FILE_READ_ATTRIBUTES; share read/write/delete; OPEN_EXISTING;
    // FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS.
    using (var handle = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      Info info;
      if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info)) throw new Exception("IDENTITY_UNAVAILABLE");
      return info;
    }
  }
}
'@
  $info = [CodeFerryFileIdentity]::Read([string]$request.path)
  $inode = ([uint64]$info.IndexHigh -shl 32) -bor [uint64]$info.IndexLow
  @{dev=$info.Volume.ToString(); ino=$inode.ToString(); nlink=$info.Links.ToString(); directory=(($info.Attributes -band 0x10) -ne 0); reparse=(($info.Attributes -band 0x400) -ne 0)} | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine('WINDOWS_IDENTITY_UNAVAILABLE'); exit 1 }
