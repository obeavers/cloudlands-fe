import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import payload from './atomic-host-payload.cjs';
const directories: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-payload-test-'));
  directories.push(dir);
  return dir;
};
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function fixture(target = 'aarch64-apple-darwin') {
  const directory = temp();
  const binary = Buffer.alloc(64);
  if (target.endsWith('apple-darwin')) {
    binary.writeUInt32LE(0xfeedfacf, 0);
    binary.writeUInt32LE(target.startsWith('aarch64') ? 0x0100000c : 0x01000007, 4);
  } else {
    Buffer.from('7f454c460201', 'hex').copy(binary);
    binary.writeUInt16LE(62, 18);
  }
  const manifest = {
    schemaVersion: 1,
    binary: 'intent-atomic-host',
    target,
    packageVersion: '0.1.0',
    atomicRevision: 'b'.repeat(40),
    rustToolchain: '1.98.0',
    contractVersion: 2,
    storeFormat: 2,
    hostLockSha256: 'c'.repeat(64),
    sourceSha256: 'd'.repeat(64),
    binarySha256: hash(binary),
    authoritativeActivation: false,
  };
  fs.writeFileSync(path.join(directory, 'intent-atomic-host'), binary);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(directory, 'upstream.json'),
    JSON.stringify({ revision: manifest.atomicRevision, toolchain: manifest.rustToolchain }),
  );
  fs.writeFileSync(path.join(directory, 'LICENSE'), 'Apache-2.0 test fixture');
  fs.writeFileSync(path.join(directory, 'NOTICE'), 'Fixture only; not a signed/native build');
  return { directory, manifest, binary };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
describe('experimental Atomic host package', () => {
  it.each([
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-unknown-linux-gnu',
    'x86_64-unknown-linux-musl',
  ])('validates target-specific bytes and stages the same relative locator: %s', (target) => {
    const source = fixture(target),
      sidecar = temp();
    const stamp = payload.stagePayload(source.directory, sidecar, target);
    expect(payload.payloadDirectory(sidecar)).toBe(path.join(sidecar, 'libexec', 'atomic-host'));
    expect(payload.stampMatches(sidecar, target, stamp)).toBe(true);
    expect(payload.readPayload(payload.payloadDirectory(sidecar), target).manifest).toEqual(
      source.manifest,
    );
    expect(payload.stagePayload(payload.payloadDirectory(sidecar), sidecar, target)).toEqual(stamp);
  });
  it('clears a previously staged host when the next daemon archive has no host', () => {
    const source = fixture(),
      sidecar = temp();
    payload.stagePayload(source.directory, sidecar, source.manifest.target);
    expect(payload.stagePayload(null, sidecar, 'x86_64-pc-windows-msvc')).toBeNull();
    expect(fs.readdirSync(payload.payloadDirectory(sidecar))).toEqual([]);
    expect(payload.stampMatches(sidecar, 'x86_64-pc-windows-msvc', null)).toBe(true);
    expect(payload.stampMatches(sidecar, source.manifest.target, undefined)).toBe(false);
  });
  it('refuses wrong architecture, corrupted bytes, incomplete and symlink payloads', () => {
    const source = fixture();
    expect(() => payload.readPayload(source.directory, 'x86_64-apple-darwin')).toThrow();
    fs.appendFileSync(path.join(source.directory, 'intent-atomic-host'), 'changed');
    expect(() => payload.readPayload(source.directory, source.manifest.target)).toThrow();
    fs.writeFileSync(path.join(source.directory, 'intent-atomic-host'), source.binary);
    fs.unlinkSync(path.join(source.directory, 'NOTICE'));
    expect(() => payload.readPayload(source.directory, source.manifest.target)).toThrow();
    fs.symlinkSync(path.join(source.directory, 'LICENSE'), path.join(source.directory, 'NOTICE'));
    expect(() => payload.readPayload(source.directory, source.manifest.target)).toThrow();
  });
  it('detects a corrupted notice even when executable and manifest are unchanged', () => {
    const source = fixture(),
      sidecar = temp();
    const stamp = payload.stagePayload(source.directory, sidecar, source.manifest.target);
    fs.appendFileSync(path.join(payload.payloadDirectory(sidecar), 'NOTICE'), 'corrupted');
    expect(payload.stampMatches(sidecar, source.manifest.target, stamp)).toBe(false);
  });
  it('requires all stamp hashes and refuses modified metadata', () => {
    const source = fixture(),
      sidecar = temp();
    const stamp = payload.stagePayload(source.directory, sidecar, source.manifest.target);
    fs.appendFileSync(path.join(payload.payloadDirectory(sidecar), 'manifest.json'), ' ');
    expect(payload.stampMatches(sidecar, source.manifest.target, stamp)).toBe(false);
  });
  it('refreshes only the packaged hash after the signer changes executable bytes', () => {
    const source = fixture();
    fs.appendFileSync(path.join(source.directory, 'intent-atomic-host'), 'signature fixture');
    payload.refreshSignedHash(source.directory);
    const signed = payload.readPayload(source.directory, source.manifest.target).manifest;
    expect(signed.unsignedBinarySha256).toBe(source.manifest.binarySha256);
    expect(signed.binarySha256).not.toBe(source.manifest.binarySha256);
    expect(signed.atomicRevision).toBe(source.manifest.atomicRevision);
  });
});
