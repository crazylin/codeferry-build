import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve('source');
const { stageTauriResources } = await import(pathToFileURL(resolve(root, 'scripts/tauri-resources.mjs')));
await stageTauriResources(root);
try {
  await access(resolve(root, 'desktop-tauri/dist/index.html'));
  const releaseConfigPath = resolve(root, 'desktop-tauri/src-tauri/tauri.release.json');
  const releaseConfig = JSON.parse(await readFile(releaseConfigPath, 'utf8'));
  releaseConfig.build = { ...releaseConfig.build, beforeBuildCommand: '' };
  await writeFile(releaseConfigPath, JSON.stringify(releaseConfig));
} catch {}
