const MIIOcommandsVocabulary = require('../lib/commandsLib.js');
const MIIOdevtypesVocabulary = require('../lib/devtypesLib.js');
const EventEmitter = require('events');
const mihome = require('node-mihome');
const registerMiHomeModels = require('../lib/registerMiHomeModels');

// Ensure device definitions under `defFiles/` are usable by node-mihome.
registerMiHomeModels(mihome);

module.exports = function(RED) {
  function MIIOdevicesNode(n) {
    RED.nodes.createNode(this,n);
    let node = this;

    node.setMaxListeners(255);
    
    node.name = n.name;
    node.room = n.room;
    node.MI_id = n.MI_id;
    node.device_type = n.device_type;
    node.model = n.model;

    node.address = n.address;
    node.token = n.token;
    
    node.isMIOT = n.isMIOT;
    node.username = n.username;
    node.password = n.password
    
    node.isPolling = n.isPolling;
    node.pollinginterval = n.pollinginterval;

    // 0) Transfering data from runtime to filter commands CONFIG-node and commands in SEND-node
    var NODE_PATH = '/node-red-contrib-miio-localdevices/nodes/';
    
    RED.httpAdmin.get(NODE_PATH + 'getHumidList/', function (req, res) {
      var ImportedHumidList = MIIOdevtypesVocabulary.humid_list();
      res.json(ImportedHumidList);
    });
    RED.httpAdmin.get(NODE_PATH + 'getPurifList/', function (req, res) {
      var ImportedPurifList = MIIOdevtypesVocabulary.purif_list();
      res.json(ImportedPurifList);
    });
    RED.httpAdmin.get(NODE_PATH + 'getHeatFanList/', function (req, res) {
      var ImportedHeatFanList = MIIOdevtypesVocabulary.heatfan_list();
      res.json(ImportedHeatFanList);
    });
    RED.httpAdmin.get(NODE_PATH + 'getVacuumList/', function (req, res) {
      var ImportedVacuumList = MIIOdevtypesVocabulary.vacuum_list();
      res.json(ImportedVacuumList);
    });
    RED.httpAdmin.get(NODE_PATH + 'getLightsList/', function (req, res) {
      var ImportedLightsList = MIIOdevtypesVocabulary.light_list();
      res.json(ImportedLightsList);
    });

    RED.httpAdmin.get(NODE_PATH + 'getCommands/' + node.id, function (req, res) {
      var ModelForCommand = node.model;
      var ImportedJSON = MIIOcommandsVocabulary.command_list(ModelForCommand);
      res.json(ImportedJSON);
    });

    // 1) Initialization of MI Protocols
    MiioConnect ();
    MiotConnect ();

    // 2) Setting up the device
    const device = mihome.device({
      id: node.MI_id,
      model: node.model,
      address: node.address,
      token: node.token,
  });

    // If a device is powered off / offline, some MIoT requests can hang long enough
    // to block the serialized operation queue. Add explicit timeouts so we fail fast.
    const INIT_TIMEOUT_MS = Number(process.env.MIIO_INIT_TIMEOUT_MS) || 1500;
    const OP_TIMEOUT_MS = Number(process.env.MIIO_OP_TIMEOUT_MS) || 1500;

    // When a device is offline (powered off), repeatedly calling init() every poll cycle
    // just burns time and blocks other ops in the queue. Use a short backoff window
    // after failures to reduce noise and improve responsiveness.
    const OFFLINE_BACKOFF_MS = Number(process.env.MIIO_OFFLINE_BACKOFF_MS) || 5000;
    let offlineUntil = 0;

    function withTimeout(promise, ms, label) {
      let t;
      const timeout = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
    }

    // Serialize all operations that touch the shared `device` instance.
    // Polling (`ConnDevice`) and Send Command handlers can otherwise overlap,
    // leading to a poll cycle calling `device.destroy()` while a command is in-flight.
    let deviceOp = Promise.resolve();
    function enqueueDeviceOp(fn) {
      deviceOp = deviceOp.then(fn, fn);
      return deviceOp;
    }

    // Attach the properties listener once.
    // Previously this was done inside `ConnDevice()` which runs repeatedly,
    // causing MaxListenersExceededWarning and growing memory usage.
    device.on('properties', (data) => {
      NewData = data;
      // check for any changes in properties
      for (var key in NewData) {
        var value = NewData[key];
        if (key in OldData) {
          if (OldData[key] !== value) {
            node.emit('onChange', data);
            OldData = data;
          }
        }
      }
      // case with no changes in properties
      OldData = data;
    });

    // 3) Defining auto-polling variables
    Poll_or_Not = node.isPolling;
    if (node.pollinginterval == null) {Polling_Interval = 30} 
    else {Polling_Interval = node.pollinginterval};

    // 4) Tiding Up after device is destroyed
    node.on('close', () => OnClose());

    // 5) Main Function - Polling the device
    OldData = {};
    ConnDevice().then((data) => {
      data = OldData;    
      node.emit('onInit', data);
    });
    
    // 6) Commands from send-node
    ExecuteSingleCMD ();
    ExecuteJsonCMD ();
    
    // 7) Auto-polling cycle
    setTimeout(function run() {    
      // 7.1) stop auto-polling cycle
      if (Poll_or_Not == false) {return};
      // 7.2) continue auto-polling cycle
      if (Poll_or_Not == true && Polling_Interval > 0) {
        // 7.2.1) re-define auto-polling interval
        if (node.pollinginterval == null) {New_Interval = 30}
        else {New_Interval = node.pollinginterval};
        // 7.2.2) check for changing the Interval, if changed then stop previous cycle
        if (New_Interval == Polling_Interval) {
          ConnDevice ();
          setTimeout(run, Polling_Interval * 1000);
        }; 
      };
    },  Polling_Interval * 1000);


    // functions in USE:
    // A) Initializing MiLocal
    function MiioConnect () {
      mihome.miioProtocol.init();
    };
    // B) Logging into MiCloud if needed
    async function MiotConnect () {
      MIOT_login = node.isMIOT;
      if (MIOT_login == true) {
        await mihome.miCloudProtocol.login(node.username, node.password);
      } else {return};
    };
    // C) OnClose Destroying
    function OnClose () {
      device.destroy();
    };
    // D) Main Function - Polling the device
    async function ConnDevice () {
      return enqueueDeviceOp(async () => {
        let inited = false;
        try {
          const now = Date.now();
          if (now < offlineUntil) {
            // Device is likely offline; skip this poll cycle.
            return;
          }

          // D.1) connect to device and poll for properties
          await withTimeout(device.init(), INIT_TIMEOUT_MS, 'device.init');
          inited = true;

          // Success: clear offline backoff.
          offlineUntil = 0;
        } catch (exception) {
          // D.2) catching errors from MIHOME Protocol
          PollError = `Mihome Exception. IP: ${node.address} -> ${exception.message}`;
          node.emit('onError', PollError);

          // Any init/poll failure sets a short backoff window.
          if (!inited) {
            offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;
          }
        } finally {
          // Always destroy to ensure sockets are cleaned up even on failures/timeouts.
          try {
            device.destroy();
          } catch (_) {}
        }
      });
    };
    // E) Executing single command from send-node 
    function ExecuteSingleCMD () {
      node.on('onSingleCommand', async function (SingleCMD, SinglePayload) {
        await enqueueDeviceOp(async () => {
          let inited = false;
          try {
            // E.1) Initializing device if MIOT
            if (device._miotSpecType) {
              await withTimeout(device.init(), INIT_TIMEOUT_MS, 'device.init');
              inited = true;
            };
            // E.2) transfer command from input into device (in AWAIT mode)
            await withTimeout(eval("device.set" + SingleCMD + "(" + SinglePayload + ")"), OP_TIMEOUT_MS, `device.set${SingleCMD}`);
          } catch(exception) {
            // E.3) catching errors from MIIO Protocol and sending back to send-node
            SingleCMDErrorMsg = exception.message;
            SingleCMDErrorCube = SingleCMD;
            node.emit('onSingleCMDSentError', SingleCMDErrorMsg, SingleCMDErrorCube);
          } finally {
            try {
              device.destroy();
            } catch (_) {}
          };
        });
      })
    };
    // F) Executing JSON command from send-node (for each Item in JSON asynchronously)
    function ExecuteJsonCMD () {
      node.on('onJsonCommand', async function (CustomJsonCMD) {
        await enqueueDeviceOp(async () => {
          let inited = false;
          try {
            // F.1) Initializing device if MIOT
            if (device._miotSpecType) {
              await withTimeout(device.init(), INIT_TIMEOUT_MS, 'device.init');
              inited = true;
            };

            // F.2) transfer command from input into device (in AWAIT mode)
            for (const rawKey of Object.keys(CustomJsonCMD)) {
              const key = String(rawKey).trim();
              const methodName = `set${key}`;
              const value = CustomJsonCMD[rawKey];

              try {
                if (typeof device[methodName] !== 'function') {
                  throw new Error(`Unknown command: ${key} (missing ${methodName}())`);
                }

                await withTimeout(device[methodName](value), OP_TIMEOUT_MS, `device.${methodName}`);
              } catch (exception) {
                // Emit per-key error but continue processing the rest.
                const msg = `Command failed: ${key}(${JSON.stringify(value)}) -> ${exception.message}`;
                node.emit('onJsonCMDSentError', msg, CustomJsonCMD);
              }
            }
          } catch(exception) {
            // F.3) catching errors from MIIO Protocol and sending back to send-node
            JsonCMDErrorMsg = exception.message;
            JsonCMDErrorCube = CustomJsonCMD;
            node.emit('onJsonCMDSentError', JsonCMDErrorMsg, JsonCMDErrorCube);
          } finally {
            try {
              device.destroy();
            } catch (_) {}
          };
        });
      });
    };
  };

  RED.nodes.registerType("MIIOdevices",MIIOdevicesNode);
}