import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=resolve('source');
const {stageTauriResources}=await import(pathToFileURL(resolve(root,'scripts/tauri-resources.mjs')));
await stageTauriResources(root);
