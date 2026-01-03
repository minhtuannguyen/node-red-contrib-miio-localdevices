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

  files
    .filter(f => f.endsWith('.js'))
    .forEach(f => {
      const full = path.join(defDir, f);
      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const Def = require(full);
        const model = Def && Def.model;
        if (typeof model === 'string' && model.length) {
          mihome.models[model] = Def;
        }
      } catch (e) {
        // Some legacy defFiles depend on modules not shipped by this repo.
        // Skip them so they don't block registering other models.
      }
    });
};
