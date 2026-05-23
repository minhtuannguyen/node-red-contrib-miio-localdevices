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
        
        // Build output message structure
        var outMsg = {};
        outMsg.name = node.MIdevice.name + " - " + node.MIdevice.room;
        outMsg.address = node.MIdevice.address;
        outMsg.model = node.MIdevice.model;
        
        // Preserve original message properties if configured
        if (node.config.passthrough) {
          outMsg = Object.assign({}, msg, outMsg);
        }
        
        try {
          // Create a temporary device connection to fetch current properties
          const device = mihome.device({
            id: node.MIdevice.MI_id,
            model: node.MIdevice.model,
            address: node.MIdevice.address,
            token: node.MIdevice.token,
          });

          const FETCH_TIMEOUT_MS = 15000;

          // Set up a one-time listener for properties
          const dataPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error('Timeout waiting for device properties'));
            }, FETCH_TIMEOUT_MS);

            device.on('properties', (data) => {
              clearTimeout(timer);
              resolve(data);
            });
          });

          // Initialize device — wrapped with a timeout so an offline or
          // unreachable device (including a failed MIoT spec fetch) does not
          // block Node-RED indefinitely.
          await Promise.race([
            device.init(),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`Device ${node.MIdevice.address} did not respond within ${FETCH_TIMEOUT_MS / 1000}s`)),
                FETCH_TIMEOUT_MS,
              )
            ),
          ]);

          // Wait for properties data
          const DataAsIS = await dataPromise;

          // Clean up
          device.destroy();
          
          // Convert and send data
          var DataToBe = convertObj(DataAsIS);
          outMsg.payload = DataToBe;
          
          node.status({fill: "green", shape: "dot", text: "Data fetched"});
          send(outMsg);
          
          setTimeout(() => {
            node.status({});
          }, 2000);
          
          if (done) done();
        } catch (error) {
          node.status({fill: "red", shape: "ring", text: "Fetch error"});
          node.warn("Failed to fetch device data: " + error.message);
          
          setTimeout(() => {
            node.status({});
          }, 3000);
          
          if (done) done(error);
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
