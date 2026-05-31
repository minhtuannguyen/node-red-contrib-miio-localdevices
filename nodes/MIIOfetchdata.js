'use strict';

const MIIOpropsVocabulary = require('../lib/propsLib.js');
const mihome              = require('node-mihome');

const FETCH_TIMEOUT_MS = 15000;

module.exports = function(RED) {
  function MIIOfetchdataNode(config) {
    RED.nodes.createNode(this, config);

    const node    = this;
    node.config   = config;
    node.MIdevice = RED.nodes.getNode(config.devices);

    node.status({});

    if (!node.MIdevice) {
      node.status({ fill: 'red', shape: 'ring', text: 'No device configured' });
      return;
    }

    let statusTimer = null;

    function setStatus(fill, shape, text, clearAfterMs) {
      clearTimeout(statusTimer);
      node.status({ fill, shape, text });
      if (clearAfterMs) {
        statusTimer = setTimeout(() => node.status({}), clearAfterMs);
      }
    }

    node.on('close', () => clearTimeout(statusTimer));

    // Iter 15: Cache properties_list at construction instead of calling it on
    // every fetch trigger. properties_list() runs a switch statement on every
    // call; caching it here costs nothing and saves CPU on busy flows.
    const _propKeys = config.prop_type === 'Friendly'
      ? MIIOpropsVocabulary.properties_list(node.MIdevice.model)
      : null;

    function convertObj(DataAsIS) {
      if (!_propKeys) return DataAsIS;
      const out = {};
      for (const k of Object.keys(DataAsIS)) {
        const fk = _propKeys[k];
        out[(fk && fk !== '') ? fk : k] = DataAsIS[k];
      }
      return out;
    }

    node.on('input', async function(msg, send, done) {
      send = send || function() { node.send.apply(node, arguments); };
      done = done || function() {};

      setStatus('blue', 'dot', 'Fetching...');

      let baseMsg = {
        name:    node.MIdevice.name + ' - ' + node.MIdevice.room,
        address: node.MIdevice.address,
        model:   node.MIdevice.model,
      };
      if (node.config.passthrough) {
        baseMsg = Object.assign({}, msg, baseMsg);
      }

      let device      = null;
      let timeoutHandle = null;

      try {
        const DataAsIS = await new Promise((resolve, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Device ' + node.MIdevice.address + ' did not respond within ' + (FETCH_TIMEOUT_MS / 1000) + 's')),
            FETCH_TIMEOUT_MS,
          );

          // refresh: 0 → poll() skips setInterval.
          // This device object is short-lived (created per trigger, destroyed
          // immediately after), so the library's internal polling interval
          // would be created and immediately cleared — wasted work.
          device = mihome.device({
            id:      node.MIdevice.MI_id,
            model:   node.MIdevice.model,
            address: node.MIdevice.address,
            token:   node.MIdevice.token,
            refresh: 0,
          });

          // Iter R4: Use named listener refs so each removes the other when it
          // fires, preventing stale once() listeners from holding closure refs
          // to resolve/reject/timeoutHandle after the promise settles.
          // Iter R5: Also clean up both listeners in the device.init().catch()
          // error path so no stale listener remains in any settlement branch.
          function onUnavailable(reason) {
            device.removeListener('properties', onProperties);
            clearTimeout(timeoutHandle);
            reject(new Error('Device unavailable: ' + (reason || 'connection failed')));
          }
          function onProperties(data) {
            device.removeListener('unavailable', onUnavailable);
            clearTimeout(timeoutHandle);
            resolve(data);
          }
          device.once('unavailable', onUnavailable);
          device.once('properties',  onProperties);

          device.init().catch((err) => {
            device.removeListener('unavailable', onUnavailable);
            device.removeListener('properties',  onProperties);
            clearTimeout(timeoutHandle);
            reject(err);
          });
        });

        // ── Success ───────────────────────────────────────────────────────────
        try { device.destroy(); } catch (_) {}

        setStatus('green', 'dot', 'Online', 3000);
        send([Object.assign({}, baseMsg, { reachable: true, payload: convertObj(DataAsIS) }), null]);
        done();

      } catch (error) {
        // ── Offline / timeout ─────────────────────────────────────────────────
        clearTimeout(timeoutHandle);
        try { if (device) device.destroy(); } catch (_) {}

        setStatus('red', 'ring', 'Offline', 5000);
        send([null, Object.assign({}, baseMsg, { reachable: false, error: error.message, payload: {} })]);
        done();
      }
    });
  }

  RED.nodes.registerType('MIIOfetchdata', MIIOfetchdataNode);
};
