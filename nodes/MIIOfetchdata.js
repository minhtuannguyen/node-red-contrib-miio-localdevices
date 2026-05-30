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

    // Track the status timer so rapid triggers don't pile up dozens of
    // pending clearance timeouts.
    let statusTimer = null;

    function setStatus(fill, shape, text, clearAfterMs) {
      clearTimeout(statusTimer);
      node.status({ fill, shape, text });
      if (clearAfterMs) {
        statusTimer = setTimeout(() => node.status({}), clearAfterMs);
      }
    }

    node.on('close', () => clearTimeout(statusTimer));

    node.on('input', async function(msg, send, done) {
      send = send || function() { node.send.apply(node, arguments); };

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
            () => reject(new Error(`Device ${node.MIdevice.address} did not respond within ${FETCH_TIMEOUT_MS / 1000}s`)),
            FETCH_TIMEOUT_MS,
          );

          // refresh: 0  →  poll() skips setInterval.
          // This device object is short-lived (created per request and destroyed
          // right after), so the library's internal polling interval would be
          // created and immediately cleared — wasted work on every trigger.
          device = mihome.device({
            id:      node.MIdevice.MI_id,
            model:   node.MIdevice.model,
            address: node.MIdevice.address,
            token:   node.MIdevice.token,
            refresh: 0,
          });

          device.once('properties', (data) => {
            clearTimeout(timeoutHandle);
            resolve(data);
          });

          device.init().catch((err) => {
            clearTimeout(timeoutHandle);
            reject(err);
          });
        });

        // ── Success ───────────────────────────────────────────────────────────
        try { device.destroy(); } catch (_) {}

        setStatus('green', 'dot', 'Online', 3000);
        send([Object.assign({}, baseMsg, { reachable: true, payload: convertObj(DataAsIS) }), null]);
        if (done) done();

      } catch (error) {
        // ── Offline / timeout ─────────────────────────────────────────────────
        clearTimeout(timeoutHandle);
        try { if (device) device.destroy(); } catch (_) {}

        setStatus('red', 'ring', 'Offline', 5000);
        send([null, Object.assign({}, baseMsg, { reachable: false, error: error.message, payload: {} })]);
        if (done) done();
      }
    });

    function convertObj(DataAsIS) {
      if (node.config.prop_type !== 'Friendly') return DataAsIS;
      const keys = MIIOpropsVocabulary.properties_list(node.MIdevice.model);
      const out  = {};
      for (const k of Object.keys(DataAsIS)) {
        const fk = keys[k];
        out[(fk && fk !== '') ? fk : k] = DataAsIS[k];
      }
      return out;
    }
  }

  RED.nodes.registerType('MIIOfetchdata', MIIOfetchdataNode);
};
