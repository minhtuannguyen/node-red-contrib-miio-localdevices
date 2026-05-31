'use strict';

const MIIOpropsVocabulary = require('../lib/propsLib.js');

module.exports = function(RED) {
  function MIIOgetdataNode(config) {
    RED.nodes.createNode(this, config);

    const node    = this;
    node.config   = config;
    node.MIdevice = RED.nodes.getNode(config.devices);

    node.status({});

    // Iter 9: Show a clear status when no device config is attached, rather
    // than silently returning and leaving the node in an ambiguous blank state.
    if (!node.MIdevice) {
      node.status({ fill: 'red', shape: 'ring', text: 'No device configured' });
      return;
    }

    const Poll_or_Not      = node.MIdevice.isPolling;
    const Polling_Interval = node.MIdevice.pollinginterval;

    // Base message built once; payload is updated on each send.
    // Iter R8: initialise payload to null so node.error(err, msg) always
    // delivers a complete message object to downstream Catch nodes, even
    // when an error fires before the first properties event.
    const msg = {
      polling: Poll_or_Not ? `ON. Every ${Polling_Interval} sec` : 'OFF',
      name:    node.MIdevice.name + ' - ' + node.MIdevice.room,
      address: node.MIdevice.address,
      model:   node.MIdevice.model,
      payload: null,
    };

    let statusTimer = null;

    function setStatus(fill, shape, text, clearAfterMs) {
      clearTimeout(statusTimer);
      node.status({ fill, shape, text });
      if (clearAfterMs) {
        statusTimer = setTimeout(() => node.status({}), clearAfterMs);
      }
    }

    // Iter 10: Cache properties_list at construction instead of calling it on
    // every onChange/onInit event. properties_list() runs a switch statement
    // over the model string on every call; for high-frequency devices this
    // accumulates unnecessary CPU cycles over long uptimes.
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

    // Iter 11: Use node.error() instead of node.warn() so errors surface in
    // the Node-RED debug panel with an error badge and can be caught by a
    // Catch node downstream. node.warn() only writes to the log.
    function onError(err) {
      setStatus('red', 'ring', 'Connection: error');
      node.error(err, msg);
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
