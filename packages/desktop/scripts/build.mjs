import * as esbuild from 'esbuild'

const common = (entry, outfile) => ({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
})

await esbuild.build(common('src/main/index.ts', 'dist/main/index.js'))
await esbuild.build(common('src/preload/index.ts', 'dist/preload/index.js'))

console.log('[build] main + preload -> dist/')
