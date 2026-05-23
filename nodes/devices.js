'use strict';

const MIIOcommandsVocabulary = require('../lib/commandsLib.js');
const MIIOdevtypesVocabulary = require('../lib/devtypesLib.js');
const mihome = require('node-mihome');
const registerMiHomeModels = require('../lib/registerMiHomeModels');

// Ensure device definitions under `defFiles/` are usable by node-mihome.
registerMiHomeModels(mihome);

const NODE_PATH = '/node-red-contrib-miio-localdevices/nodes/';

// How long (ms) to wait for a device to respond before giving up.
// This prevents the node from hanging forever when a device is offline.
const DEVICE_TIMEOUT_MS = 15000;

// Wrap any promise with a hard timeout so offline devices don't block Node-RED.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label || 'Device'} did not respond within ${ms / 1000}s`)),
        ms,
      )
    ),
  ]);
}

// Track which RED instances have had the static routes registered to avoid
// duplicate registrations when multiple device nodes are deployed.
const _routesRegistered = new WeakSet();

module.exports = function(RED) {
  // Register static device-list routes exactly once per Node-RED runtime.
  if (!_routesRegistered.has(RED)) {
    _routesRegistered.add(RED);
    RED.httpAdmin.get(NODE_PATH + 'getHumidList/',   (req, res) => res.json(MIIOdevtypesVocabulary.humid_list()));
    RED.httpAdmin.get(NODE_PATH + 'getPurifList/',   (req, res) => res.json(MIIOdevtypesVocabulary.purif_list()));
    RED.httpAdmin.get(NODE_PATH + 'getHeatFanList/', (req, res) => res.json(MIIOdevtypesVocabulary.heatfan_list()));
    RED.httpAdmin.get(NODE_PATH + 'getVacuumList/',  (req, res) => res.json(MIIOdevtypesVocabulary.vacuum_list()));
    RED.httpAdmin.get(NODE_PATH + 'getLightsList/',  (req, res) => res.json(MIIOdevtypesVocabulary.light_list()));
  }

  function MIIOdevicesNode(n) {
    RED.nodes.createNode(this, n);
    let node = this;

    node.setMaxListeners(255);

    node.name            = n.name;
    node.room            = n.room;
    node.MI_id           = n.MI_id;
    node.device_type     = n.device_type;
    node.model           = n.model;
    node.address         = n.address;
    node.token           = n.token;
    node.isMIOT          = n.isMIOT;
    node.username        = n.username;
    node.password        = n.password;
    node.isPolling       = n.isPolling;
    node.pollinginterval = n.pollinginterval;

    // Per-node route: includes node.id so it must stay inside the constructor.
    RED.httpAdmin.get(NODE_PATH + 'getCommands/' + node.id, (req, res) => {
      res.json(MIIOcommandsVocabulary.command_list(node.model));
    });

    // 1) Initialize MI Protocols
    MiioConnect();
    MiotConnect();

    // 2) Set up the device instance
    const device = mihome.device({
      id:      node.MI_id,
      model:   node.model,
      address: node.address,
      token:   node.token,
    });

    // ── Operation queue ───────────────────────────────────────────────────────
    // Serializes all calls that touch `device` (polling + commands) without
    // building up an ever-growing promise chain.
    let _opBusy = false;
    const _opQueue = [];

    function enqueueDeviceOp(fn) {
      return new Promise((resolve, reject) => {
        _opQueue.push({ fn, resolve, reject });
        _drainQueue();
      });
    }

    async function _drainQueue() {
      if (_opBusy || _opQueue.length === 0) return;
      _opBusy = true;
      const { fn, resolve, reject } = _opQueue.shift();
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        _opBusy = false;
        _drainQueue();
      }
    }

    // 3) Attach the properties listener once (not inside ConnDevice which runs
    //    on every poll — that caused MaxListenersExceededWarning + memory growth).
    let OldData = {};
    device.on('properties', (data) => {
      for (const key in data) {
        if (key in OldData && OldData[key] !== data[key]) {
          node.emit('onChange', data);
          break;
        }
      }
      OldData = data;
    });

    // 4) Auto-polling variables — local to this node instance (no global leaks)
    let Poll_or_Not     = node.isPolling;
    let Polling_Interval = (node.pollinginterval != null) ? Number(node.pollinginterval) : 30;

    // 5) Clean up when the node is removed or redeployed
    node.on('close', () => OnClose());

    // 6) Initial data fetch
    ConnDevice().then(() => {
      node.emit('onInit', OldData);
    });

    // 7) Register send-command handlers
    ExecuteSingleCMD();
    ExecuteJsonCMD();

    // 8) Auto-polling cycle
    setTimeout(function run() {
      if (!Poll_or_Not) return;
      if (Polling_Interval > 0) {
        const New_Interval = (node.pollinginterval != null) ? Number(node.pollinginterval) : 30;
        if (New_Interval === Polling_Interval) {
          ConnDevice();
          setTimeout(run, Polling_Interval * 1000);
        }
      }
    }, Polling_Interval * 1000);


    // ── Helper functions ──────────────────────────────────────────────────────

    function MiioConnect() {
      mihome.miioProtocol.init();
    }

    async function MiotConnect() {
      if (node.isMIOT) {
        await mihome.miCloudProtocol.login(node.username, node.password);
      }
    }

    function OnClose() {
      Poll_or_Not = false;      // stop the polling loop
      _opQueue.length = 0;      // discard pending queued operations
      try { device.destroy(); } catch (_) {}
    }

    // D) Poll the device for its current properties
    async function ConnDevice() {
      return enqueueDeviceOp(async () => {
        try {
          await withTimeout(device.init(), DEVICE_TIMEOUT_MS, `Device ${node.address}`);
          device.destroy();
        } catch (exception) {
          node.emit('onError', `Mihome Exception. IP: ${node.address} -> ${exception.message}`);
          try { device.destroy(); } catch (_) {}
        }
      });
    }

    // E) Execute a single named command from the send-node
    function ExecuteSingleCMD() {
      node.on('onSingleCommand', (SingleCMD, SinglePayload) => {
        enqueueDeviceOp(async () => {
          try {
            if (device._miotSpecType) {
              await withTimeout(device.init(), DEVICE_TIMEOUT_MS, `Device ${node.address}`);
            }
            await eval('device.set' + SingleCMD + '(' + SinglePayload + ')');
            device.destroy();
          } catch (exception) {
            node.emit('onSingleCMDSentError', exception.message, SingleCMD);
            try { device.destroy(); } catch (_) {}
          }
        });
      });
    }

    // F) Execute a JSON map of commands from the send-node
    function ExecuteJsonCMD() {
      node.on('onJsonCommand', (CustomJsonCMD) => {
        enqueueDeviceOp(async () => {
          try {
            if (device._miotSpecType) {
              await withTimeout(device.init(), DEVICE_TIMEOUT_MS, `Device ${node.address}`);
            }

            for (const rawKey of Object.keys(CustomJsonCMD)) {
              const key        = String(rawKey).trim();
              const methodName = `set${key}`;
              const value      = CustomJsonCMD[rawKey];
              try {
                if (typeof device[methodName] !== 'function') {
                  throw new Error(`Unknown command: ${key} (missing ${methodName}())`);
                }
                await device[methodName](value);
              } catch (exception) {
                node.emit(
                  'onJsonCMDSentError',
                  `Command failed: ${key}(${JSON.stringify(value)}) -> ${exception.message}`,
                  CustomJsonCMD,
                );
              }
            }

            device.destroy();
          } catch (exception) {
            node.emit('onJsonCMDSentError', exception.message, CustomJsonCMD);
            try { device.destroy(); } catch (_) {}
          }
        });
      });
    }
  }

  RED.nodes.registerType('MIIOdevices', MIIOdevicesNode);
};
