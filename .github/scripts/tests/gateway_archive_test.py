import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


worker = load('worker', pathlib.Path(sys.argv.pop(1)))
canonical = load('canonical', pathlib.Path(__file__).resolve().parents[1] / 'canonical-gateway-archive.py')
TAG = 'codeferry-gateway:fixture'
REVISION = 'a' * 40
MIGRATIONS = 'b' * 64
RELEASE = {'version': '0.3.0', 'source_commit': REVISION}
INDEX = 'application/vnd.oci.image.index.v1+json'
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
CONFIG = 'application/vnd.oci.image.config.v1+json'
LAYER = 'application/vnd.oci.image.layer.v1.tar'


def blob(files, value, media):
    raw = value if isinstance(value, bytes) else json.dumps(value, separators=(',', ':')).encode()
    digest = hashlib.sha256(raw).hexdigest(); files['blobs/sha256/' + digest] = raw
    return {'mediaType': media, 'digest': 'sha256:' + digest, 'size': len(raw)}


def export_fixture(migrations=MIGRATIONS):
    files = {}; layer_io = io.BytesIO()
    with tarfile.open(fileobj=layer_io, mode='w') as archive:
        member = tarfile.TarInfo('app/fixture'); member.size = 7
        archive.addfile(member, io.BytesIO(b'fixture'))
    layer = blob(files, layer_io.getvalue(), LAYER)
    config = blob(files, {'os': 'linux', 'architecture': 'amd64', 'rootfs': {'type': 'layers', 'diff_ids': [layer['digest']]},
        'config': {'User': '10001:10001', 'Entrypoint': ['/app/codeferry-gateway'], 'WorkingDir': '/app',
        'Labels': {'io.codeferry.product': 'CodeFerry', 'org.opencontainers.image.version': '0.3.0',
        'org.opencontainers.image.revision': REVISION, 'io.codeferry.migrations': migrations}}}, CONFIG)
    manifest = blob(files, {'schemaVersion': 2, 'mediaType': MANIFEST, 'config': config, 'layers': [layer]}, MANIFEST)
    manifest['annotations'] = {'io.containerd.image.name': 'docker.io/library/' + TAG, 'org.opencontainers.image.ref.name': 'fixture'}
    files['index.json'] = json.dumps({'schemaVersion': 2, 'mediaType': INDEX, 'manifests': [manifest]}).encode()
    files['manifest.json'] = json.dumps([{'Config': 'blobs/sha256/' + config['digest'][7:], 'RepoTags': [TAG], 'Layers': ['blobs/sha256/' + layer['digest'][7:]]}]).encode()
    files['oci-layout'] = b'{"imageLayoutVersion":"1.0.0"}'
    selected = set(files)
    # Moby 27/28 emits the older repository map and V1 image configs too.
    files['repositories'] = json.dumps({'codeferry-gateway': {'fixture': layer['digest'][7:]}}).encode()
    blob(files, {'id': '1' * 64, 'parent': '2' * 64, 'os': 'linux', 'created': '1970-01-01T00:00:00Z'}, CONFIG)
    return files, selected


class CanonicalGatewayArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name) / 'job-local.tar.gz'

    def write(self, files):
        with tarfile.open(self.path, 'w:gz') as archive:
            for name, raw in files.items():
                member = tarfile.TarInfo(name); member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw))

    def normalize(self):
        canonical.canonicalize(worker, self.path, RELEASE, MIGRATIONS, TAG)

    def reject(self, files):
        self.write(files); before = self.path.read_bytes()
        with self.assertRaises(worker.WorkerError): self.normalize()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob('.gateway-canonical-*')), [])

    def test_official_export_legacy_metadata_is_pruned_but_exact_graph_survives(self):
        files, selected = export_fixture(); self.write(files)
        with self.assertRaises(worker.WorkerError): worker.validate_image_archive(self.path, RELEASE, MIGRATIONS)
        self.normalize()
        self.assertEqual(worker.validate_image_archive(self.path, RELEASE, MIGRATIONS), TAG)
        with tarfile.open(self.path) as archive: self.assertEqual(set(archive.getnames()), selected)

    def test_containerd_graph_without_legacy_metadata_is_still_accepted(self):
        files, selected = export_fixture(); self.write({name: files[name] for name in selected})
        self.normalize()
        self.assertEqual(worker.validate_image_archive(self.path, RELEASE, MIGRATIONS), TAG)

    def test_docker29_config_digest_annotation_is_bound_then_removed(self):
        files, selected = export_fixture(); index = json.loads(files['index.json'])
        config = json.loads(files['manifest.json'])[0]['Config']
        index['manifests'][0]['annotations']['config.digest'] = 'sha256:' + config.rsplit('/', 1)[1]
        files['index.json'] = json.dumps(index).encode(); self.write({name: files[name] for name in selected})
        self.normalize()
        self.assertEqual(worker.validate_image_archive(self.path, RELEASE, MIGRATIONS), TAG)
        with tarfile.open(self.path) as archive:
            canonical_index = json.load(archive.extractfile('index.json'))
        self.assertNotIn('config.digest', canonical_index['manifests'][0]['annotations'])
        index['manifests'][0]['annotations']['config.digest'] = 'sha256:' + 'c' * 64
        files['index.json'] = json.dumps(index).encode(); self.reject(files)

    def test_collector_cli_uses_real_migration_digest_and_verifies_final_bytes(self):
        migrations = worker.migration_digest([])
        files, _ = export_fixture(migrations); self.write(files)
        migration_path = self.path.parent / 'MIGRATIONS.json'; migration_path.write_text('[]')
        result = subprocess.run([sys.executable, canonical.__file__, worker.__file__, str(self.path), str(migration_path), RELEASE['version'], REVISION, TAG], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'GATEWAY_ARCHIVE_CANONICAL_IDENTITY_VERIFIED\n')
        self.assertEqual(worker.validate_image_archive(self.path, RELEASE, migrations), TAG)

    def test_legacy_blob_requires_linux_v1_identity(self):
        for value in ({'id': '1' * 64}, {'id': '1' * 64, 'os': 'windows'}, {'os': 'linux'}):
            with self.subTest(value=value):
                files, _ = export_fixture(); blob(files, value, CONFIG); self.reject(files)

    def test_conflicting_index_or_repository_tags_are_rejected_without_rewrite(self):
        files, _ = export_fixture(); index = json.loads(files['index.json'])
        index['manifests'].append(index['manifests'][0]); files['index.json'] = json.dumps(index).encode()
        self.reject(files)
        files, _ = export_fixture(); files['repositories'] = b'{"other-product":{"injected":"abc"}}'
        self.reject(files)

    def test_unreferenced_oci_graph_and_arbitrary_extra_file_are_rejected(self):
        files, _ = export_fixture(); blob(files, {'schemaVersion': 2, 'mediaType': INDEX, 'manifests': []}, INDEX)
        self.reject(files)
        files, _ = export_fixture(); files['unexpected.json'] = b'{}'
        self.reject(files)

    def test_corrupt_selected_digest_and_legacy_digest_are_rejected(self):
        files, _ = export_fixture(); layer = json.loads(files['manifest.json'])[0]['Layers'][0]
        files[layer] = b'X' + files[layer][1:]; self.reject(files)
        files, selected = export_fixture(); legacy = next(name for name in files if name.startswith('blobs/') and name not in selected)
        files[legacy] = files[legacy].replace(b'1970', b'1971'); self.reject(files)

    def test_source_identity_and_sealed_archive_are_not_rewritten(self):
        files, _ = export_fixture(); self.write(files); before = self.path.read_bytes()
        with self.assertRaises(worker.WorkerError): canonical.canonicalize(worker, self.path, {**RELEASE, 'source_commit': 'c' * 40}, MIGRATIONS, TAG)
        self.assertEqual(self.path.read_bytes(), before)
        pathlib.Path(str(self.path) + '.metadata.json').write_text('{}')
        with self.assertRaises(worker.WorkerError) as caught: self.normalize()
        self.assertEqual(caught.exception.code, 'GATEWAY_ARCHIVE_ALREADY_SEALED')
        self.assertEqual(self.path.read_bytes(), before)


if __name__ == '__main__': unittest.main()
