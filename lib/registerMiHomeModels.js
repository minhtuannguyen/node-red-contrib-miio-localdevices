'use strict';

const fs = require('fs');
const path = require('path');

let registered = false;

/**
 * Registers device model classes from `defFiles/` into `node-mihome` at runtime.
 *
 * node-mihome's `device()` factory only knows models from its own `lib/devices/*`.
 * This repo keeps device implementations under `defFiles/`, so we inject them
 * into `mihome.models` to make them instantiable.
 */
module.exports = function registerMiHomeModels(mihome) {
  if (registered) return;
  registered = true;

  if (!mihome || !mihome.models) {
    throw new Error('registerMiHomeModels: invalid mihome instance');
  }

  const defDir = path.resolve(__dirname, '..', 'defFiles');
  let files = [];
  try {
    files = fs.readdirSync(defDir);
  } catch (e) {
    // No defFiles folder; nothing to register.
    return;
  }

  // Iter 18: Log a warning for any defFile that fails to load so misconfigured
  // device definitions are visible in the Node-RED log rather than silently
  // skipped. Failures in one file still don't block the rest.
  // Iter 19: Only iterate over .js files; other files (README, .gitkeep, etc.)
  // are skipped at the filter level rather than inside the try/catch.
  files
    .filter(f => f.endsWith('.js'))
    .forEach(f => {
      const full = path.join(defDir, f);
      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const Def = require(full);
        const model = Def && Def.model;
        if (typeof model === 'string' && model.length > 0) {
          mihome.models[model] = Def;
        }
      } catch (e) {
        // Non-fatal: a single broken defFile must not prevent others from loading.
        // The warning surfaces in the Node-RED startup log for easy debugging.
        console.warn('[miio-localdevices] Failed to load defFile ' + f + ': ' + e.message);
      }
    });
};
