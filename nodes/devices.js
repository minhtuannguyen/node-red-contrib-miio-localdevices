'use strict';

const MIIOcommandsVocabulary = require('../lib/commandsLib.js');
const MIIOdevtypesVocabulary = require('../lib/devtypesLib.js');
const mihome                 = require('node-mihome');
const registerMiHomeModels   = require('../lib/registerMiHomeModels');

registerMiHomeModels(mihome);

const NODE_PATH        = '/node-red-contrib-miio-localdevices/nodes/';
const DEVICE_TIMEOUT_MS = 15000;

// Wrap a promise with a hard deadline.
// The internal timer is ALWAYS cleared when the promise settles (resolve or
// reject) so it never leaks a 15-second closure on the happy path.
function withTimeout(promise, ms, label) {
  let timer;
  const race = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label || 'Device'} did not respond within ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([promise, race]).finally(() => clearTimeout(timer));
}

const _routesRegistered = new WeakSet();

module.exports = function(RED) {
  // One-time setup per Node-RED runtime: protocol init + static admin routes.
  if (!_routesRegistered.has(RED)) {
    _routesRegistered.add(RED);
    mihome.miioProtocol.init();
    RED.httpAdmin.get(NODE_PATH + 'getHumidList/',   (req, res) => res.json(MIIOdevtypesVocabulary.humid_list()));
    RED.httpAdmin.get(NODE_PATH + 'getPurifList/',   (req, res) => res.json(MIIOdevtypesVocabulary.purif_list()));
    RED.httpAdmin.get(NODE_PATH + 'getHeatFanList/', (req, res) => res.json(MIIOdevtypesVocabulary.heatfan_list()));
    RED.httpAdmin.get(NODE_PATH + 'getVacuumList/',  (req, res) => res.json(MIIOdevtypesVocabulary.vacuum_list()));
    RED.httpAdmin.get(NODE_PATH + 'getLightsList/',  (req, res) => res.json(MIIOdevtypesVocabulary.light_list()));
  }

  function MIIOdevicesNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;

    // Multiple MIIOgetdata/sendcommand nodes each attach listeners here.
    node.setMaxListeners(100);

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

    // Per-node: node.id is unique so this must stay inside the constructor.
    RED.httpAdmin.get(NODE_PATH + 'getCommands/' + node.id, (req, res) => {
      res.json(MIIOcommandsVocabulary.command_list(node.model));
    });

    // Cloud auth — non-blocking; surface errors via the standard error channel.
    if (node.isMIOT) {
      mihome.miCloudProtocol.login(node.username, node.password)
        .catch(e => node.emit('onError', `Cloud login failed: ${e.message}`));
    }

    // refresh: 0  →  this.refresh = 0  →  poll() skips setInterval.
    // We manage our own polling loop so we don't want the library to also start
    // its own interval on every device.init() call — that would create+destroy
    // a setInterval on every poll cycle for no benefit.
    const device = mihome.device({
      id:      node.MI_id,
      model:   node.model,
      address: node.address,
      token:   node.token,
      refresh: 0,
    });

    // ── Operation queue ──────────────────────────────────────────────────────
    // Prevents concurrent access to the shared `device` instance (poll vs
    // commands). Uses a fixed-size array — constant memory regardless of
    // uptime. Previous implementation grew a promise chain indefinitely.
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
        _drainQueue().catch(() => {}); // tail-call; catch prevents unhandled rejection
      }
    }

    // Single properties listener, attached once.
    // Attaching inside ConnDevice() (which runs every poll) caused
    // MaxListenersExceededWarning and memory growth proportional to uptime.
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

    // ── Polling ──────────────────────────────────────────────────────────────
    const Poll_or_Not     = node.isPolling;
    const Polling_Interval = (node.pollinginterval != null) ? Number(node.pollinginterval) : 30;
    let _pollTimer = null;

    // Close handler registered before any async work so it always runs.
    node.on('close', OnClose);

    ConnDevice()
      .then(() => node.emit('onInit', OldData))
      .catch(e => node.emit('onError', `Init failed: ${e.message}`));

    ExecuteSingleCMD();
    ExecuteJsonCMD();

    // Only schedule the polling loop if polling is actually enabled.
    // Avoids creating a timer that immediately returns on its first invocation.
    if (Poll_or_Not && Polling_Interval > 0) {
      _pollTimer = setTimeout(function run() {
        if (!Poll_or_Not) return;
        ConnDevice();
        _pollTimer = setTimeout(run, Polling_Interval * 1000);
      }, Polling_Interval * 1000);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function OnClose() {
      // Stop the polling loop and release all pending operations immediately.
      clearTimeout(_pollTimer);
      _opQueue.length = 0;
      try { device.destroy(); } catch (_) {}
    }

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

    function ExecuteSingleCMD() {
      node.on('onSingleCommand', (SingleCMD, SinglePayload) => {
        enqueueDeviceOp(async () => {
          try {
            if (device._miotSpecType) {
              await withTimeout(device.init(), DEVICE_TIMEOUT_MS, `Device ${node.address}`);
            }
            // Direct method lookup instead of eval():
            //   • faster (V8 can optimise the surrounding function)
            //   • safe (no code injection)
            //   • correct for all payload types including objects
            const method = 'set' + SingleCMD;
            if (typeof device[method] !== 'function') {
              throw new Error(`Unknown command: ${method}()`);
            }
            await device[method](SinglePayload);
            device.destroy();
          } catch (exception) {
            node.emit('onSingleCMDSentError', exception.message, SingleCMD);
            try { device.destroy(); } catch (_) {}
          }
        });
      });
    }

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
                node.emit('onJsonCMDSentError',
                  `Command failed: ${key}(${JSON.stringify(value)}) -> ${exception.message}`,
                  CustomJsonCMD);
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
