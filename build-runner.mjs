#!/usr/bin/env node
import { build } from 'esbuild'
import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'

const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'))
const pluginId = manifest.id
const entry = './src/runner.ts'

if (!existsSync(entry)) {
  console.log('No runner.ts — skipping')
  process.exit(0)
}

// esbuild auto-detects Yarn PnP by walking up parent directories looking for
// a .pnp.cjs/.pnp.data.json, regardless of what this repo's own .yarnrc.yml
// actually declares (nodeLinker: node-modules, no local .pnp.cjs at all) — if
// any ancestor directory happens to contain one (e.g. a stray/unrelated file
// left over from a different Yarn PnP project elsewhere on the machine), it
// switches to pnpapi resolution and rejects perfectly resolvable deps. Alias
// third-party runtime deps to their real resolved path up front so esbuild
// never has to fall through to that auto-detection at all.
const req = createRequire(import.meta.url)
const alias = {}
for (const dep of ['yaml', 'zod']) {
  try {
    alias[dep] = req.resolve(dep)
  } catch {
    // Not a dependency of this plugin — leave unaliased.
  }
}

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: `dist/${pluginId}-runner.js`,
  external: [
    'node:*','fs','path','os','http','https','net','crypto',
    'child_process','worker_threads','stream','events','util',
    'url','buffer','readline','tty','assert','zlib',
    '@voiden/executors','@voiden/sdk','electron',
  ],
  alias,
  minify: true,
})
console.log(`Built dist/${pluginId}-runner.js`)
