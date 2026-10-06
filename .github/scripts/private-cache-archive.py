#!/usr/bin/env python3
"""Bounded regular-file Cargo cache archive; never use tar extractall."""
import argparse
import gzip
import hashlib
import json
import os
import pathlib
import stat
import tarfile
import time

TARGETS = {root + '/' + profile for root in ['upstream/webcodex/target', 'gateway-rs/target',
                                          'desktop-tauri/src-tauri/target']
           for profile in ['debug', 'release']}
MAX_ARCHIVE = 1792 * 1024**2
MAX_EXPANDED = 12 * 1024**3
MAX_ENTRIES = 100000
MAX_METADATA = 64 * 1024
DEADLINE_SECONDS = 600


class CacheError(Exception):
    pass


def check(condition):
    if not condition:
        raise CacheError()


def allowed(name):
    check(isinstance(name, str) and 0 < len(name.encode()) <= 1024
          and '\\' not in name and ':' not in name and not any(ord(c) < 32 for c in name))
    path = pathlib.PurePosixPath(name)
    check(not path.is_absolute() and not any(p in ('.', '..') for p in path.parts)
          and name == path.as_posix() and len(path.parts) <= 64)
    check(any(name == root or name.startswith(root + '/') for root in TARGETS))
    return path


def excluded(name):
    path = pathlib.PurePosixPath(name)
    return (any(part in {'bundle', 'incremental', 'release-assets', 'private', '.git'}
                or part.endswith('.dSYM') for part in path.parts)
            or path.name.endswith(('.sig', '.key', '.pem', '.p12', '.pfx', '.dmg', '.AppImage', '.deb', '.log'))
            or path.name.endswith('-setup.exe') or 'tauri-updater' in path.name)


def compiled_cache_file(name, mode):
    """Keep compiled dependency graph; omit copied final/test executables."""
    target = next(root for root in TARGETS if name == root or name.startswith(root + '/'))
    relative = pathlib.PurePosixPath(name).relative_to(target)
    if not relative.parts:
        return True
    if relative.parts[0] not in {'deps', 'build', '.fingerprint'}:
        return False
    if relative.parts[0] == 'deps' and (name.endswith(('.exe', '.pdb'))
                                      or stat.S_ISREG(mode) and mode & 0o111 and not pathlib.PurePosixPath(name).suffix):
        return False
    return True


def bounded_pax(payload):
    """Reject sparse metadata before tarfile can allocate/parse its sparse map."""
    cursor = 0
    while cursor < len(payload):
        space = payload.find(b' ', cursor, min(cursor + 12, len(payload)))
        check(space > cursor and payload[cursor:space].isdigit())
        length = int(payload[cursor:space])
        check(length > space - cursor + 3 and cursor + length <= len(payload))
        record = payload[space + 1:cursor + length]
        check(record.endswith(b'\n') and b'=' in record)
        key = record.split(b'=', 1)[0]
        check(key and not key.startswith(b'GNU.sparse') and all(32 < byte < 127 for byte in key))
        cursor += length
    check(cursor == len(payload))


def bounded_headers(archive, deadline):
    # tarfile reads PAX/long-name metadata eagerly, so bound raw headers first.
    expanded = 0; headers = 0
    with gzip.open(archive, 'rb') as source:
        while True:
            header = source.read(512)
            if not header or header == b'\0' * 512:
                break
            check(len(header) == 512)
            size = tarfile.nti(header[124:136]); headers += 1
            check(size >= 0 and headers <= MAX_ENTRIES * 2 and header[156:157] != b'S')
            if header[156:157] in (b'x', b'g', b'L', b'K'):
                check(size <= MAX_METADATA)
            remaining = ((size + 511) // 512) * 512
            expanded += remaining + 512
            check(expanded <= MAX_EXPANDED + MAX_ENTRIES * 2048)
            if header[156:157] in (b'x', b'g'):
                payload = source.read(size)
                check(len(payload) == size and time.monotonic() < deadline)
                bounded_pax(payload)
                remaining -= size
            while remaining:
                chunk = source.read(min(remaining, 1024 * 1024))
                check(chunk and time.monotonic() < deadline)
                remaining -= len(chunk)


def identity(path):
    check(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= MAX_ARCHIVE)
    h = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            h.update(chunk)
    return {'size': path.stat().st_size, 'sha256': h.hexdigest()}


def pack(source, archive, selected):
    check(selected and set(selected) <= TARGETS and not archive.exists())
    deadline = time.monotonic() + DEADLINE_SECONDS; entries = 0; expanded = 0; included = []
    with archive.open('xb') as raw:
        os.chmod(archive, 0o600)
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=1, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as output:
                for target in selected:
                    root = source / target
                    if not root.exists():
                        continue
                    check(root.is_dir() and not root.is_symlink())
                    included.append(target)
                    stack = [root]
                    while stack:
                        path = stack.pop(); name = path.relative_to(source).as_posix(); allowed(name)
                        if excluded(name):
                            continue
                        info = path.lstat(); check(not path.is_symlink())
                        if not compiled_cache_file(name, info.st_mode):
                            continue
                        entries += 1; check(entries <= MAX_ENTRIES and time.monotonic() < deadline)
                        check(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))
                        item = tarfile.TarInfo(name); item.mtime = info.st_mtime
                        item.mode = (0o700 if path.is_dir() else 0o600 | (info.st_mode & 0o111))
                        item.uid = item.gid = 0; item.uname = item.gname = ''
                        if path.is_dir():
                            item.type = tarfile.DIRTYPE; output.addfile(item)
                            stack.extend(sorted(path.iterdir(), reverse=True))
                        else:
                            item.size = info.st_size; expanded += item.size
                            check(expanded <= MAX_EXPANDED)
                            with path.open('rb') as incoming:
                                output.addfile(item, incoming)
                            check(path.stat().st_size == info.st_size)
                        check(raw.tell() <= MAX_ARCHIVE)
    check(included and expanded > 0)
    return {**identity(archive), 'entries': entries, 'expanded': expanded, 'targets': sorted(included)}


def restore(archive, stage, selected):
    identity(archive)
    check(selected and set(selected) <= TARGETS and stage.is_dir() and not stage.is_symlink()
          and not list(stage.iterdir()))
    deadline = time.monotonic() + DEADLINE_SECONDS
    bounded_headers(archive, deadline)
    expanded = 0; members = []; seen = set(); roots = set(); by_name = {}
    with tarfile.open(archive, 'r:gz') as incoming:
        for member in incoming:
            name = member.name; allowed(name)
            check(not excluded(name) and compiled_cache_file(name, stat.S_IFDIR if member.isdir() else stat.S_IFREG | member.mode)
                  and name not in seen
                  and any(name == root or name.startswith(root + '/') for root in selected)
                  and (member.isfile() or member.isdir()) and not member.issparse() and member.size >= 0
                  and 0 < member.mtime <= time.time() + 300)
            seen.add(name); members.append(member); by_name[name] = member; expanded += member.size
            check(len(members) <= MAX_ENTRIES and expanded <= MAX_EXPANDED and time.monotonic() < deadline)
            if name in selected:
                check(member.isdir()); roots.add(name)
        check(roots == set(selected) and expanded > 0)
        # Validate all members before writing anything. Parent entries may not be files.
        for member in members:
            parent = pathlib.PurePosixPath(member.name).parent
            while str(parent) != '.':
                check(str(parent) not in seen or by_name[str(parent)].isdir())
                parent = parent.parent
        for member in members:
            path = stage / member.name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if member.isdir():
                path.mkdir(exist_ok=True, mode=0o700)
            else:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
                total = 0
                with os.fdopen(fd, 'wb') as outgoing, incoming.extractfile(member) as source:
                    while chunk := source.read(1024 * 1024):
                        total += len(chunk); check(total <= member.size and time.monotonic() < deadline)
                        outgoing.write(chunk)
                check(total == member.size)
                os.chmod(path, 0o600 | (member.mode & 0o111))
                os.utime(path, (member.mtime, member.mtime))
    return {'entries': len(members), 'expanded': expanded, 'targets': sorted(roots)}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('mode', choices=['pack', 'restore'])
    parser.add_argument('--source', type=pathlib.Path); parser.add_argument('--archive', type=pathlib.Path, required=True)
    parser.add_argument('--stage', type=pathlib.Path); parser.add_argument('--targets', required=True)
    args = parser.parse_args(); selected = args.targets.split(',')
    result = pack(args.source, args.archive, selected) if args.mode == 'pack' else restore(args.archive, args.stage, selected)
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('PRIVATE_CACHE_ARCHIVE_INVALID') from None
