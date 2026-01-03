const EventEmitter = require('events');
const mihome = require('node-mihome');

module.exports = function(RED) {
  function MIIOsendcommandNode(config) {
    RED.nodes.createNode(this,config);
    
    var node = this;
    node.config = config;
    node.MIdevice = RED.nodes.getNode(config.devices);

    node.status({}); //cleaning status
    
    node.on('input', function(msg) {
      node.status({fill:"gray",shape:"dot",text:"Connecting..."});
      
      // 1) initialization of local MIIO Protocol
      mihome.miioProtocol.init();

      // 2) working with current device
      if (node.MIdevice) {                
        // 2.1) defining outgoing msg structure
        msg.name = node.MIdevice.name + " - " + node.MIdevice.room;
        msg.address = node.MIdevice.address;
        msg.model = node.MIdevice.model;

        // 2.2) sending Single and JSON commands separately 
        if (node.config.command == "Custom") {
          SendCustomJsonCMD ();
        } else {
          SendSingleCMD ();
        };
      };


      // functions in USE:
      // A) For single command
      function SendSingleCMD () {
        // A.1) sending data to config-node
        SingleCMD = node.config.command;
        SinglePayload = msg.payload;

        // A.2) getting errors from config-node + sending them only once
        node.MIdevice.once('onSingleCMDSentError', (SingleCMDErrorMsg, SingleCMDErrorCube) => {
          if (SingleCMDErrorCube === node.config.command) {
            node.warn(`Mihome Exception. IP: ${node.MIdevice.address} -> ${SingleCMDErrorMsg}`);
            node.status({fill:"red",shape:"ring",text:"Command: error"});
          }
        });

        node.MIdevice.emit('onSingleCommand', SingleCMD, SinglePayload);
        // A.3) starting msg and status
        node.status({fill:"green",shape:"dot",text:"Command: sent"});
        msg.payload = {[SingleCMD]: SinglePayload};
        node.send(msg);
        // A.4) cleaning status after 5 sec timeout
        setTimeout(() => {
          node.status({});
        }, 5000);
      };
      // B) For CustomJSON command 
      function SendCustomJsonCMD () {
        // B.1) sending data to config-node
        CustomJsonCMD = msg.payload;

        if (!CustomJsonCMD || typeof CustomJsonCMD !== 'object' || Array.isArray(CustomJsonCMD)) {
          node.warn('Custom JSON command expects msg.payload to be an object like {"KeepWarmTemperature": 65}');
          node.status({fill:"red",shape:"ring",text:"Command: error"});
          return;
        }

        // B.2) getting errors from config-node + sending them only once
        node.MIdevice.once('onJsonCMDSentError', (JsonCMDErrorMsg, JsonCMDErrorCube) => {
          node.warn(`Mihome Exception. IP: ${node.MIdevice.address} -> ${JsonCMDErrorMsg}`);
          node.status({fill:"red",shape:"ring",text:"Command: error"});
        });

        node.MIdevice.emit('onJsonCommand', CustomJsonCMD);
        // B.3) starting msg and status
        node.status({fill:"green",shape:"dot",text:"Command: sent"});
        msg.payload = CustomJsonCMD;
        node.send(msg);
        // B.4) cleaning status after 15 sec timeout
        setTimeout(() => {
          node.status({});
        }, 15000);
      };
    });
  };

  RED.nodes.registerType("MIIOsendcommand",MIIOsendcommandNode);
}