'use strict';

const fs = require('fs');
const path = require('path');
const BaseDevice = require('node-mihome/lib/device-miio');

// ── MIoT spec cache ───────────────────────────────────────────────────────────
// Memory cache: shared across all device instances for the lifetime of the
// Node-RED process. Populated on first use, so subsequent device.init() calls
// (every poll cycle) never hit the network.
const specMemCache = {};

// Disk cache: survives Node-RED restarts and works without internet access
// once the spec has been fetched at least once.
const CACHE_DIR = path.resolve(__dirname, '.miot-spec-cache');

function _cachePath(specType) {
  const safe = specType.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(CACHE_DIR, safe + '.json');
}

// Iter 16: Use async fs.promises to avoid blocking the Node-RED event loop
// while reading the disk cache. A sync readFileSync stalls ALL other flows
// for the duration of the disk read (even if only a few ms per model restart).
async function _readDiskCache(specType) {
  try {
    const content = await fs.promises.readFile(_cachePath(specType), 'utf8');
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

// Iter 17: Fire-and-forget async write — we already have the spec in the
// memory cache so there is no reason to block miotFetchSpec() on the write.
// The inner try/catch ensures the returned Promise never rejects.
async function _writeDiskCache(specType, data) {
  try {
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    await fs.promises.writeFile(_cachePath(specType), JSON.stringify(data), 'utf8');
  } catch (_) {
    // Non-fatal: we still have the in-memory copy for this session.
  }
}

/**
 * Drop-in replacement for `node-mihome/lib/device-miio` that adds a two-tier
 * (memory + disk) cache for the MIoT spec.
 *
 * Fetch order:
 *   1. Memory cache  — instant, zero I/O
 *   2. Disk cache    — fast, works offline after first ever fetch
 *   3. Network fetch — only when neither cache exists; result is saved to both
 */
class CachedMiioDevice extends BaseDevice {
  async miotFetchSpec(specType) {
    // Tier 1: memory
    if (specMemCache[specType]) {
      this._miotSpec = specMemCache[specType];
      return this._miotSpec;
    }

    // Tier 2: disk (awaited because _readDiskCache is now async)
    const fromDisk = await _readDiskCache(specType);
    if (fromDisk) {
      specMemCache[specType] = fromDisk;
      this._miotSpec = fromDisk;
      return this._miotSpec;
    }

    // Tier 3: network — runs at most once per model, ever
    const result = await super.miotFetchSpec(specType);
    specMemCache[specType] = result;
    _writeDiskCache(specType, result); // fire-and-forget: no await needed
    return result;
  }
}

module.exports = CachedMiioDevice;
