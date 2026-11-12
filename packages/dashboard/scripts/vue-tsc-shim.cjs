// Run the (hoisted) vue-tsc against this workspace's own TypeScript 5.9.3 rather than the monorepo's
// root TypeScript 7. vue-tsc 3.x resolves `typescript/lib/tsc` relative to its own (hoisted) location,
// where it finds TS 7 — whose `exports` map no longer publishes `./lib/tsc`, so vue-tsc crashes. We
// redirect any `typescript`/`typescript/...` require to the local copy, returning absolute file paths
// (which also bypasses the TS `exports` gate). Nothing else is touched.
//
// TODO(revisit): remove this shim and the local typescript pin, and call `vue-tsc` directly, once
// vue-tsc supports TypeScript 7 (or the root adopts a compatible setup). No root overrides for now.
const Module = require('module');
const path = require('path');
const fs = require('fs');

const TS_DIR = path.join(__dirname, '..', 'node_modules', 'typescript');

function localTypescript(request) {
  if (request === 'typescript') return path.join(TS_DIR, 'lib', 'typescript.js');
  if (request.startsWith('typescript/')) {
    let p = path.join(TS_DIR, request.slice('typescript/'.length));
    if (!path.extname(p) && fs.existsSync(p + '.js')) p += '.js';
    return p;
  }
  return null;
}

const original = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'typescript' || request.startsWith('typescript/')) {
    const mapped = localTypescript(request);
    if (mapped && fs.existsSync(mapped)) return mapped;
  }
  return original.call(this, request, parent, isMain, options);
};

if (!fs.existsSync(path.join(TS_DIR, 'lib', 'tsc.js'))) {
  console.error('[dashboard] local typescript@5 not found; run `npm install`');
  process.exit(1);
}

// run() evaluates its default tscPath (require.resolve('typescript/lib/tsc')) now, hitting the patch above.
require(require.resolve('vue-tsc/bin/vue-tsc.js'));
