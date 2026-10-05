#!/usr/bin/env python3
"""Package one application tree; preserve executable modes and safe symlinks."""
import os
import pathlib
import stat
import sys
import zipfile


def create_zip(source, output, label='CodeFerry'):
    source = pathlib.Path(source)
    if not source.is_dir() or source.is_symlink() or label != 'CodeFerry':
        raise ValueError('DESKTOP_ZIP_INPUT_INVALID')
    root = source.resolve()
    count = 0
    total = 0
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(source.rglob('*')):
            relative = path.relative_to(source)
            if any(part in ('..', '.git') for part in relative.parts):
                raise ValueError('DESKTOP_ZIP_INPUT_INVALID')
            info = path.lstat()
            name = label + '/' + relative.as_posix()
            if stat.S_ISDIR(info.st_mode):
                continue
            record = zipfile.ZipInfo(name)
            record.create_system = 3
            record.external_attr = info.st_mode << 16
            record.compress_type = zipfile.ZIP_DEFLATED
            if stat.S_ISLNK(info.st_mode):
                link = os.readlink(path)
                resolved = (path.parent / link).resolve()
                if os.path.isabs(link) or not resolved.is_relative_to(root):
                    raise ValueError('DESKTOP_ZIP_UNSAFE_LINK')
                archive.writestr(record, link.encode())
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                if total > 4 * 1024**3 or info.st_size > 2 * 1024**3:
                    raise ValueError('DESKTOP_ZIP_TOO_LARGE')
                with path.open('rb') as incoming, archive.open(record, 'w', force_zip64=True) as outgoing:
                    while chunk := incoming.read(1024*1024):
                        outgoing.write(chunk)
            else:
                raise ValueError('DESKTOP_ZIP_INPUT_INVALID')
            count += 1
            if count > 32768:
                raise ValueError('DESKTOP_ZIP_TOO_LARGE')
    if count == 0:
        raise ValueError('DESKTOP_ZIP_EMPTY')
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError('DESKTOP_ZIP_CORRUPT')


if __name__ == '__main__':
    try:
        create_zip(sys.argv[1], sys.argv[2])
    except (OSError, ValueError, IndexError, zipfile.BadZipFile):
        raise SystemExit('DESKTOP_ZIP_FAILED')
