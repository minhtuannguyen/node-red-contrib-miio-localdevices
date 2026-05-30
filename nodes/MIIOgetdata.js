'use strict';

const MIIOpropsVocabulary = require('../lib/propsLib.js');

module.exports = function(RED) {
  function MIIOgetdataNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    node.config  = config;
    node.MIdevice = RED.nodes.getNode(config.devices);

    node.status({});

    if (!node.MIdevice) return;

    // All local — no global leaks.
    const Poll_or_Not      = node.MIdevice.isPolling;
    const Polling_Interval = node.MIdevice.pollinginterval;

    // Build the base message once; payload is updated on each send.
    const msg = {
      polling: Poll_or_Not ? `ON. Every ${Polling_Interval} sec` : 'OFF',
      name:    node.MIdevice.name + ' - ' + node.MIdevice.room,
      address: node.MIdevice.address,
      model:   node.MIdevice.model,
    };

    // Single tracked timer so rapid events don't pile up dozens of timeouts.
    let statusTimer = null;

    function setStatus(fill, shape, text, clearAfterMs) {
      clearTimeout(statusTimer);
      node.status({ fill, shape, text });
      if (clearAfterMs) {
        statusTimer = setTimeout(() => node.status({}), clearAfterMs);
      }
    }

    // Conversion: MiProtocol keys → Friendly names (or passthrough).
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

    // Named listener functions so they can be cleanly removed on close.
    // Previously anonymous functions were passed to .on() and could never be
    // removed, causing listeners to accumulate with every redeploy.
    function onInit(data) {
      setStatus('green', 'dot', 'Connection: OK', 2000);
      msg.payload = convertObj(data);
      node.send(msg);
    }

    function onChange(data) {
      setStatus('green', 'dot', 'State: changed', 2000);
      msg.payload = convertObj(data);
      node.send(msg);
    }

    function onError(err) {
      setStatus('red', 'ring', 'Connection: error');
      node.warn(err);
    }

    node.MIdevice.on('onInit',   onInit);
    node.MIdevice.on('onChange', onChange);
    node.MIdevice.on('onError',  onError);

    // Clean up everything on close (redeploy or flow stop).
    node.on('close', () => {
      clearTimeout(statusTimer);
      node.MIdevice.removeListener('onInit',   onInit);
      node.MIdevice.removeListener('onChange', onChange);
      node.MIdevice.removeListener('onError',  onError);
    });
  }

  RED.nodes.registerType('MIIOgetdata', MIIOgetdataNode);
};
