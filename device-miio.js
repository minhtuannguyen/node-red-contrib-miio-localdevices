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

function _readDiskCache(specType) {
  try {
    return JSON.parse(fs.readFileSync(_cachePath(specType), 'utf8'));
  } catch (_) {
    return null;
  }
}

function _writeDiskCache(specType, data) {
  try {
    // mkdirSync with recursive:true is idempotent — no existsSync needed.
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(_cachePath(specType), JSON.stringify(data), 'utf8');
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

    // Tier 2: disk
    const fromDisk = _readDiskCache(specType);
    if (fromDisk) {
      specMemCache[specType] = fromDisk;
      this._miotSpec = fromDisk;
      return this._miotSpec;
    }

    // Tier 3: network — runs at most once per model, ever
    const result = await super.miotFetchSpec(specType);
    specMemCache[specType] = result;
    _writeDiskCache(specType, result);
    return result;
  }
}

module.exports = CachedMiioDevice;
