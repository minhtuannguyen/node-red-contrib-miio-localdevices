const MIIOpropsVocabulary = require('../lib/propsLib.js');
const mihome = require('node-mihome');

module.exports = function(RED) {
  function MIIOfetchdataNode(config) {
    RED.nodes.createNode(this, config);
    
    var node = this;
    node.config = config;
    node.MIdevice = RED.nodes.getNode(config.devices);
    
    node.status({}); // cleaning status

    if (node.MIdevice) {
      // Handle incoming messages to trigger data fetch
      node.on('input', async function(msg, send, done) {
        // For Node-RED 0.x compatibility
        send = send || function() { node.send.apply(node, arguments) };

        node.status({fill: "blue", shape: "dot", text: "Fetching..."});

        // Build base output message
        let baseMsg = {
          name:    node.MIdevice.name + " - " + node.MIdevice.room,
          address: node.MIdevice.address,
          model:   node.MIdevice.model,
        };
        if (node.config.passthrough) {
          baseMsg = Object.assign({}, msg, baseMsg);
        }

        // Single 15 s budget covers spec fetch + init + properties event.
        const FETCH_TIMEOUT_MS = 15000;
        let device = null;
        let timeoutHandle = null;

        try {
          const DataAsIS = await new Promise((resolve, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new Error(`Device ${node.MIdevice.address} did not respond within ${FETCH_TIMEOUT_MS / 1000}s`));
            }, FETCH_TIMEOUT_MS);

            device = mihome.device({
              id:      node.MIdevice.MI_id,
              model:   node.MIdevice.model,
              address: node.MIdevice.address,
              token:   node.MIdevice.token,
            });

            // Resolve as soon as the device emits its properties.
            device.once('properties', (data) => {
              clearTimeout(timeoutHandle);
              resolve(data);
            });

            // init() starts the whole chain (spec fetch → loadProperties → poll).
            device.init().catch((err) => {
              clearTimeout(timeoutHandle);
              reject(err);
            });
          });

          // Success path ─────────────────────────────────────────────────────
          try { device.destroy(); } catch (_) {}

          const outMsg = Object.assign({}, baseMsg, {
            reachable: true,
            payload:   convertObj(DataAsIS),
          });

          node.status({fill: "green", shape: "dot", text: "Online"});
          setTimeout(() => node.status({}), 3000);

          // Output 1: data; Output 2: nothing
          send([outMsg, null]);
          if (done) done();

        } catch (error) {
          // Offline / timeout path ────────────────────────────────────────────
          clearTimeout(timeoutHandle);
          try { if (device) device.destroy(); } catch (_) {}

          const errMsg = Object.assign({}, baseMsg, {
            reachable: false,
            error:     error.message,
            payload:   {},
          });

          node.status({fill: "red", shape: "ring", text: "Offline"});
          setTimeout(() => node.status({}), 5000);

          // Output 1: nothing; Output 2: offline info
          send([null, errMsg]);
          // done() without error — the offline case is handled via output 2
          if (done) done();
        }
      });
    } else {
      node.status({fill: "red", shape: "ring", text: "No device configured"});
    }

    // Conversion JSON with properties to friendly names as per Vocabulary
    function convertObj(DataAsIS) {
      var DataToBe = {};
      if (node.config.prop_type == "Friendly") {
        var FriendlyKeys = MIIOpropsVocabulary.properties_list(node.MIdevice.model);
        Object.keys(DataAsIS).forEach((OldKey) => {
          let NewKey = FriendlyKeys[OldKey];
          if (NewKey === undefined || NewKey === null || NewKey === '') {
            NewKey = OldKey;
          }
          DataToBe[NewKey] = DataAsIS[OldKey];
        });
      } else {
        DataToBe = DataAsIS;
      }
      return DataToBe;
    }
  }

  RED.nodes.registerType("MIIOfetchdata", MIIOfetchdataNode);
}
