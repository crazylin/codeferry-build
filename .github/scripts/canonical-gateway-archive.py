"""Seal a job-local Docker save into the exact inspected one-image archive."""
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import stat
import sys
import tarfile
import tempfile

DIGEST = re.compile(r'sha256:[a-f0-9]{64}')
HEX = re.compile(r'[a-f0-9]{64}')
INDEX = 'application/vnd.oci.image.index.v1+json'
MANIFESTS = {'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'}


def canonicalize(worker, path, release, migrations, tag):
    # This is a producer operation before publication, never an updater rewrite.
    if pathlib.Path(str(path) + '.metadata.json').exists():
        raise worker.WorkerError('GATEWAY_ARCHIVE_ALREADY_SEALED')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= worker.MAX_BYTES:
        raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
    worker.archive_headers_bounded(path)
    temporary = None
    try:
        with tarfile.open(path, 'r:*') as archive:
            members = {}; expanded = 0; rewritten = {}
            for member in archive:
                expanded += member.size
                name = pathlib.PurePosixPath(member.name)
                if len(members) >= 512 or expanded > 8 * 1024 ** 3:
                    raise worker.WorkerError('DEPLOY_ARCHIVE_TOO_LARGE')
                if member.name in members or name.is_absolute() or '..' in name.parts or '\\' in member.name or not (member.isfile() or member.isdir()):
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                members[member.name] = member

            def read_json(name):
                if name in rewritten:
                    return json.loads(rewritten[name])
                member = members.get(name)
                if member is None or not member.isfile() or not 0 < member.size <= 256 * 1024:
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                return json.load(archive.extractfile(member))

            manifest = read_json('manifest.json')
            if not isinstance(manifest, list) or len(manifest) != 1 or not isinstance(manifest[0], dict):
                raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
            legacy = manifest[0]
            if legacy.get('RepoTags') != [tag]:
                raise worker.WorkerError('DEPLOY_IMAGE_TAG_INVALID')
            layers = legacy.get('Layers')
            if not isinstance(layers, list) or not 0 < len(layers) <= 64 or not all(isinstance(name, str) for name in layers):
                raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
            config = read_json(legacy.get('Config'))
            worker.validate_image_config(config, release, migrations)
            selected = {'manifest.json', legacy['Config'], *layers}

            def descriptor_name(descriptor):
                if not isinstance(descriptor, dict) or not isinstance(descriptor.get('digest'), str) or not DIGEST.fullmatch(descriptor['digest']):
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                return 'blobs/sha256/' + descriptor['digest'][7:]

            def collect_graph(descriptor, depth=0):
                if depth > 4:
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                name = descriptor_name(descriptor)
                if name in selected:
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                selected.add(name)
                document = read_json(name)
                if not isinstance(document, dict):
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                if descriptor.get('mediaType') == INDEX:
                    children = document.get('manifests')
                    if not isinstance(children, list) or len(children) != 1:
                        raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                    collect_graph(children[0], depth + 1)
                elif descriptor.get('mediaType') in MANIFESTS:
                    selected.add(descriptor_name(document.get('config')))
                    rows = document.get('layers')
                    if not isinstance(rows, list) or len(rows) > 64:
                        raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                    selected.update(descriptor_name(row) for row in rows)
                else:
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')

            if 'oci-layout' in members or 'index.json' in members:
                if read_json('oci-layout') != {'imageLayoutVersion': '1.0.0'}:
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                root = read_json('index.json')
                if not isinstance(root, dict) or not isinstance(root.get('manifests'), list) or len(root['manifests']) != 1:
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                descriptor = root['manifests'][0]
                if not isinstance(descriptor, dict):
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                annotations = descriptor.get('annotations')
                # Docker 29/containerd adds a redundant config.digest hint to
                # the root descriptor. Bind it to the actual selected config
                # before removing it; it cannot retarget the canonical image.
                if isinstance(annotations, dict) and 'config.digest' in annotations:
                    config_name = legacy['Config']
                    if not re.fullmatch(r'blobs/sha256/[a-f0-9]{64}', config_name) or annotations['config.digest'] != 'sha256:' + config_name.rsplit('/', 1)[1]:
                        raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                    del annotations['config.digest']
                    rewritten['index.json'] = json.dumps(root, separators=(',', ':')).encode()
                selected.update({'oci-layout', 'index.json'})
                collect_graph(root['manifests'][0])
                worker.validate_oci_graph(archive, {name: members[name] for name in selected}, read_json, legacy, tag)

            for name, member in members.items():
                if not member.isfile() or name in selected:
                    continue
                if name == 'repositories':
                    # Moby v27/v28 save.go maps the tag to the final diffID;
                    # the manifest uses that same diffID as its layer blob path.
                    repository, reference = tag.split(':', 1)
                    top = pathlib.PurePosixPath(layers[-1]).parts[-1]
                    if top == 'layer.tar':
                        top = pathlib.PurePosixPath(layers[-1]).parts[-2]
                    if read_json(name) != {repository: {reference: top}}:
                        raise worker.WorkerError('DEPLOY_IMAGE_TAG_INVALID')
                    continue
                # Moby 27/28 exports backwards-compatible V1 image JSON blobs
                # which its OCI index does not reference. Prune only that shape;
                # a second OCI graph, other tag, arbitrary file or bad digest fails.
                parts = pathlib.PurePosixPath(name).parts
                if len(parts) != 3 or parts[:2] != ('blobs', 'sha256') or not HEX.fullmatch(parts[2]):
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                value = read_json(name)
                raw = archive.extractfile(member).read()
                if hashlib.sha256(raw).hexdigest() != parts[2] or not isinstance(value, dict) or not HEX.fullmatch(value.get('id', '')) or value.get('os') != 'linux' or ('parent' in value and not HEX.fullmatch(value['parent'])) or any(key in value for key in ('schemaVersion', 'mediaType', 'manifests')):
                    raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')

            fd, name = tempfile.mkstemp(prefix='.gateway-canonical-', suffix='.tar.gz', dir=path.parent)
            os.close(fd); temporary = pathlib.Path(name)
            with tarfile.open(temporary, 'w:gz', format=tarfile.PAX_FORMAT) as output:
                for name in sorted(selected):
                    member = members[name]
                    if not member.isfile():
                        raise worker.WorkerError('DEPLOY_ARCHIVE_INVALID')
                    if name in rewritten:
                        member = tarfile.TarInfo(name); member.size = len(rewritten[name]); member.mode = 0o644
                        output.addfile(member, io.BytesIO(rewritten[name]))
                    else:
                        output.addfile(member, archive.extractfile(member))
        if worker.validate_image_archive(temporary, release, migrations) != tag:
            raise worker.WorkerError('DEPLOY_IMAGE_TAG_INVALID')
        if pathlib.Path(str(path) + '.metadata.json').exists():
            raise worker.WorkerError('GATEWAY_ARCHIVE_ALREADY_SEALED')
        os.replace(temporary, path); temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    if len(sys.argv) != 7:
        raise ValueError('GATEWAY_ARCHIVE_ARGUMENT_INVALID')
    spec = importlib.util.spec_from_file_location('worker', sys.argv[1])
    worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
    rows = json.loads(pathlib.Path(sys.argv[3]).read_text())
    canonicalize(worker, pathlib.Path(sys.argv[2]), {'version': sys.argv[4], 'source_commit': sys.argv[5]}, worker.migration_digest(rows), sys.argv[6])
    print('GATEWAY_ARCHIVE_CANONICAL_IDENTITY_VERIFIED')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(getattr(error, 'code', 'DEPLOY_ARCHIVE_INVALID'), file=sys.stderr)
        sys.exit(1)
