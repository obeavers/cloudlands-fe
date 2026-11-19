// Experimental host payload validation shared by archive staging and the Mac seal hook.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const BINARY = 'intent-atomic-host';
const FILES = [BINARY, 'manifest.json', 'LICENSE', 'NOTICE', 'upstream.json'];
const TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl',
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const payloadDigest = (bytes) => {
  const hash = createHash('sha256');
  for (const name of FILES) hash.update(name).update('\0').update(bytes[name]).update('\0');
  return hash.digest('hex');
};
const payloadDirectory = (sidecarDirectory) =>
  path.join(sidecarDirectory, 'libexec', 'atomic-host');
const fail = () => {
  throw new Error('Invalid experimental Atomic host payload');
};
function readPayload(directory, target) {
  if (!TARGETS.includes(target)) fail();
  const entries = fs.readdirSync(directory);
  if (entries.length !== FILES.length || FILES.some((name) => !entries.includes(name))) fail();
  const bytes = {};
  for (const name of FILES) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail();
    bytes[name] = fs.readFileSync(file);
  }
  const manifest = JSON.parse(bytes['manifest.json'].toString('utf8'));
  const upstream = JSON.parse(bytes['upstream.json'].toString('utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.binary !== BINARY ||
    manifest.target !== target ||
    manifest.authoritativeActivation !== false ||
    !/^[a-f0-9]{40}$/.test(manifest.atomicRevision) ||
    !/^\d+\.\d+\.\d+$/.test(manifest.rustToolchain) ||
    !Number.isSafeInteger(manifest.contractVersion) ||
    manifest.contractVersion < 1 ||
    !Number.isSafeInteger(manifest.storeFormat) ||
    manifest.storeFormat < 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.hostLockSha256) ||
    manifest.binarySha256 !== digest(bytes[BINARY]) ||
    upstream.revision !== manifest.atomicRevision ||
    upstream.toolchain !== manifest.rustToolchain
  )
    fail();
  const binary = bytes[BINARY];
  if (target.endsWith('apple-darwin')) {
    const cpu = target.startsWith('aarch64') ? 0x0100000c : 0x01000007;
    if (
      binary.length < 8 ||
      binary.readUInt32LE(0) !== 0xfeedfacf ||
      binary.readUInt32LE(4) !== cpu
    )
      fail();
  } else if (
    binary.length < 20 ||
    binary.subarray(0, 6).toString('hex') !== '7f454c460201' ||
    binary.readUInt16LE(18) !== 62
  )
    fail();
  return { bytes, manifest };
}
function stagePayload(source, sidecarDirectory, target) {
  const destination = payloadDirectory(sidecarDirectory);
  const payload =
    source && fs.existsSync(source) && fs.readdirSync(source).length
      ? readPayload(source, target)
      : null;
  // Read every validated source byte first: copying an already staged payload onto itself is safe.
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  if (payload) {
    for (const name of FILES) fs.writeFileSync(path.join(destination, name), payload.bytes[name]);
    fs.chmodSync(path.join(destination, BINARY), 0o755);
    return {
      binarySha256: payload.manifest.binarySha256,
      manifestSha256: digest(payload.bytes['manifest.json']),
      payloadSha256: payloadDigest(payload.bytes),
    };
  }
  return null;
}
function stampMatches(sidecarDirectory, target, stamp) {
  try {
    const directory = payloadDirectory(sidecarDirectory);
    if (stamp === null) return !fs.existsSync(directory) || fs.readdirSync(directory).length === 0;
    if (!stamp || typeof stamp !== 'object') return false;
    const payload = readPayload(directory, target);
    return (
      stamp.binarySha256 === payload.manifest.binarySha256 &&
      stamp.manifestSha256 === digest(payload.bytes['manifest.json']) &&
      stamp.payloadSha256 === payloadDigest(payload.bytes)
    );
  } catch {
    return false;
  }
}
function refreshSignedHash(directory) {
  const file = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.unsignedBinarySha256 ??= manifest.binarySha256;
  manifest.binarySha256 = digest(fs.readFileSync(path.join(directory, BINARY)));
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
module.exports = { payloadDirectory, readPayload, stagePayload, stampMatches, refreshSignedHash };
