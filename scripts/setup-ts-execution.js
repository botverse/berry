const esbuild = require(`esbuild-wasm`);
const fs = require(`fs`);
const crypto = require(`crypto`);
const v8 = require(`v8`);
const zlib = require(`zlib`);
const path = require(`path`);
const pirates = require(`pirates`);

// Needed by the worker spawned by Esbuild
if (process.versions.pnp)
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ``} -r ${JSON.stringify(require.resolve(`pnpapi`))}`;

const resolveVirtual = process.versions.pnp ? require(`pnpapi`).resolveVirtual : undefined;

const weeksSinceUNIXEpoch = Math.floor(Date.now() / 604800000);

const cache = {
  version: [esbuild.version, weeksSinceUNIXEpoch, process.versions.node, !!process.setSourceMapsEnabled].join(`\0`),
  files: new Map(),
  isDirty: false,
};

const cachePath = path.join(__dirname, `../node_modules/.cache/yarn/esbuild-transpile-cache.bin`);
try {
  const cacheData = v8.deserialize(zlib.gunzipSync(fs.readFileSync(cachePath)));
  if (cacheData.version === cache.version) {
    cache.files = cacheData.files;
  }
} catch { }

function persistCache() {
  if (!cache.isDirty)
    return;
  cache.isDirty = false;

  fs.mkdirSync(path.dirname(cachePath), {recursive: true});
  const tmpPath = cachePath + crypto.randomBytes(8).toString(`hex`);
  fs.writeFileSync(
    tmpPath,
    zlib.gzipSync(
      v8.serialize({
        version: cache.version,
        files: cache.files,
      }),
      {level: 1},
    ),
  );
  fs.renameSync(tmpPath, cachePath);
}

process.once(`exit`, persistCache);
process.nextTick(persistCache);

process.setSourceMapsEnabled
  ? process.setSourceMapsEnabled(true)
  : require(`@cspotcode/source-map-support`).install({
    environment: `node`,
    retrieveSourceMap(filename) {
      filename = resolveVirtual?.(filename) || filename;

      const cacheEntry = cache.files.get(filename);
      if (cacheEntry)
        return {url: filename, map: cacheEntry.map};

      return null;
    },
  });

pirates.addHook(
  (sourceCode, filename) => {
    filename = resolveVirtual?.(filename) || filename;

    const cacheEntry = cache.files.get(filename);

    if (cacheEntry?.source === sourceCode)
      return cacheEntry.code;

    const res = esbuild.transformSync(sourceCode, {
      target: `node${process.versions.node}`,
      loader: path.extname(filename).slice(1),
      sourcefile: filename,
      sourcemap: process.setSourceMapsEnabled ? `inline` : `both`,
      platform: `node`,
      format: `cjs`,
    });

    cache.isDirty = true;
    cache.files.set(filename, {
      source: sourceCode,
      code: res.code,
      map: res.map,
    });

    return res.code;
  },
  {
    extensions: [`.tsx`, `.ts`, `.js`],
    matcher(p) {
      if (p?.endsWith(`.js`)) {
        const normalizedP = p.replace(/\\/g, `/`);
        return normalizedP.includes(`packages/yarnpkg-pnp/sources/node`) || normalizedP.endsWith(`packages/yarnpkg-pnp/sources/loader/node-options.js`);
      }

      return true;
    },
  },
);
