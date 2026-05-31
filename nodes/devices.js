'use strict';

const MIIOcommandsVocabulary = require('../lib/commandsLib.js');
const MIIOdevtypesVocabulary = require('../lib/devtypesLib.js');
const mihome                 = require('node-mihome');
const registerMiHomeModels   = require('../lib/registerMiHomeModels');

registerMiHomeModels(mihome);

const NODE_PATH         = '/node-red-contrib-miio-localdevices/nodes/';
const DEVICE_TIMEOUT_MS = 15000;

// Wrap a promise with a hard deadline.
// The timer is ALWAYS cleared when the promise settles so it never leaks.
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

    // Per-node route (node.id is unique per instance).
    RED.httpAdmin.get(NODE_PATH + 'getCommands/' + node.id, (req, res) => {
      res.json(MIIOcommandsVocabulary.command_list(node.model));
    });

    // Cloud auth — non-blocking.
    // Iter R7: Wrap in Promise.resolve().then() so any synchronous throw from
    // login() (e.g. null credentials) is caught by .catch() instead of
    // propagating synchronously and crashing Node-RED.
    if (node.isMIOT) {
      Promise.resolve()
        .then(() => mihome.miCloudProtocol.login(node.username, node.password))
        .catch(e => { if (!_closed) node.emit('onError', `Cloud login failed: ${e.message}`); });
    }

    // refresh: 0 → poll() skips setInterval.
    // We run our own loop; the library's internal interval would be wasteful.
    const device = mihome.device({
      id:      node.MI_id,
      model:   node.model,
      address: node.address,
      token:   node.token,
      refresh: 0,
    });

    // ── Closed flag ───────────────────────────────────────────────────────────
    // Iter 1: Guard every post-close async callback so closed nodes never
    // emit events, mutate state, or schedule new work.
    let _closed = false;

    // ── Operation queue ───────────────────────────────────────────────────────
    // Prevents concurrent access to the shared `device` instance.
    // Fixed-size busy-flag queue — constant memory regardless of uptime.
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
        _drainQueue().catch(() => {}); // tail-call; inner catch prevents unhandled rejection
      }
    }

    // ── initDevice helper ─────────────────────────────────────────────────────
    // Iter 2: node-mihome's loadProperties() swallows network errors internally
    // and emits 'unavailable' instead of rejecting. This means device.init()
    // ALWAYS resolves — even when the device is completely offline.
    // withTimeout(device.init(), ...) is therefore ineffective for offline
    // detection. This helper converts the 'unavailable' event back into a
    // promise rejection so offline is properly detected and reported.
    function initDevice() {
      return new Promise((resolve, reject) => {
        const onUnavailable = (reason) => {
          device.removeListener('unavailable', onUnavailable);
          reject(new Error(`Device unavailable: ${reason || 'connection failed'}`));
        };
        device.once('unavailable', onUnavailable);
        device.init().then(
          () => { device.removeListener('unavailable', onUnavailable); resolve(); },
          (err) => { device.removeListener('unavailable', onUnavailable); reject(err); },
        );
      });
    }

    // Single 'properties' listener attached once at construction.
    // Attaching inside ConnDevice() (every poll) caused listener accumulation.
    // Iter 7: Use Object.keys() instead of for...in to avoid iterating
    // inherited prototype properties.
    let OldData = {};
    device.on('properties', (data) => {
      // Iter R1: bail immediately if node is already closed to skip all work.
      if (_closed) return;
      const keys = Object.keys(data);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key in OldData && OldData[key] !== data[key]) {
          node.emit('onChange', data);
          break;
        }
      }
      OldData = data;
    });

    // ── Polling ───────────────────────────────────────────────────────────────
    const Poll_or_Not      = node.isPolling;
    const Polling_Interval = (node.pollinginterval != null) ? Number(node.pollinginterval) : 30;
    let _pollTimer = null;

    // ── Command listener refs (for cleanup) ───────────────────────────────────
    // Iter 5: Store named references so they can be removed in OnClose(),
    // preventing the config node's EventEmitter from keeping closures alive
    // after the node has been destroyed.
    let _singleCmdListener = null;
    let _jsonCmdListener   = null;

    // Close handler registered BEFORE any async work so it always runs.
    node.on('close', OnClose);

    // Initial connection: emit onInit only when properties were actually received.
    // Iter 8: Avoids sending an empty {} payload when the device is offline at
    // startup — with the initDevice() fix, ConnDevice() now rejects on offline,
    // so the .catch() branch handles it instead.
    // Iter R3: ConnDevice() catches all errors internally and always resolves
    // — the .catch() was dead code (never fired). onInit is suppressed when
    // OldData is empty (device was offline at startup).
    ConnDevice().then(() => {
      if (!_closed && Object.keys(OldData).length > 0) {
        node.emit('onInit', OldData);
      }
    });

    ExecuteSingleCMD();
    ExecuteJsonCMD();

    // Iter 7: Chain next poll to completion of current one.
    // Previously both fired concurrently: if poll takes longer than the
    // interval (e.g. 5 s interval but 15 s timeout), the queue grows
    // unboundedly. Now the next timer only starts after the previous op drains.
    if (Poll_or_Not && Polling_Interval > 0) {
      const schedulePoll = () => {
        if (_closed) return;
        _pollTimer = setTimeout(() => {
          // .catch() swallows 'Node closed' rejections on graceful shutdown
          ConnDevice().catch(() => {}).finally(schedulePoll);
        }, Polling_Interval * 1000);
      };
      schedulePoll();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function OnClose() {
      _closed = true;
      clearTimeout(_pollTimer);

      // Iter 6: Reject all pending queued ops to release their promise closures.
      // Previously _opQueue.length = 0 silently discarded pending resolve/reject
      // callbacks, leaving their closures allocated until GC (which may be long,
      // since the closures capture device, node, and OldData).
      while (_opQueue.length > 0) {
        const { reject } = _opQueue.shift();
        reject(new Error('Node closed'));
      }

      // Iter 5: Remove command listeners to prevent post-close device ops.
      if (_singleCmdListener) node.removeListener('onSingleCommand', _singleCmdListener);
      if (_jsonCmdListener)   node.removeListener('onJsonCommand',   _jsonCmdListener);

      // Iter R2: Remove all device listeners before destroy so the closed
      // node's closure (capturing node, OldData, _closed) can be GC'd even
      // if miioProtocol retains a reference to the device object internally.
      try { device.removeAllListeners(); } catch (_) {}
      try { device.destroy(); } catch (_) {}
    }

    // Iter 3: ConnDevice uses initDevice() which properly rejects on offline.
    async function ConnDevice() {
      return enqueueDeviceOp(async () => {
        try {
          await withTimeout(initDevice(), DEVICE_TIMEOUT_MS, `Device ${node.address}`);
          device.destroy();
        } catch (exception) {
          if (!_closed) node.emit('onError', `Mihome Exception. IP: ${node.address} -> ${exception.message}`);
          try { device.destroy(); } catch (_) {}
        }
      });
    }

    // Iter 4: ExecuteSingleCMD uses initDevice() for MIoT devices.
    // Iter 5: Listener stored in _singleCmdListener for cleanup.
    function ExecuteSingleCMD() {
      _singleCmdListener = (SingleCMD, SinglePayload) => {
        if (_closed) return;
        enqueueDeviceOp(async () => {
          try {
            if (device._miotSpecType) {
              await withTimeout(initDevice(), DEVICE_TIMEOUT_MS, `Device ${node.address}`);
            }
            const method = 'set' + SingleCMD;
            if (typeof device[method] !== 'function') {
              throw new Error(`Unknown command: ${method}()`);
            }
            await device[method](SinglePayload);
            try { device.destroy(); } catch (_) {}
          } catch (exception) {
            if (!_closed) node.emit('onSingleCMDSentError', exception.message, SingleCMD);
            try { device.destroy(); } catch (_) {}
          }
        });
      };
      node.on('onSingleCommand', _singleCmdListener);
    }

    // Iter 3 & 4: ExecuteJsonCMD uses initDevice() for MIoT; destroy() wrapped
    // in try/catch on the success path to prevent a double-destroy if it throws.
    // Iter 5: Listener stored in _jsonCmdListener for cleanup.
    function ExecuteJsonCMD() {
      _jsonCmdListener = (CustomJsonCMD) => {
        if (_closed) return;
        enqueueDeviceOp(async () => {
          try {
            if (device._miotSpecType) {
              await withTimeout(initDevice(), DEVICE_TIMEOUT_MS, `Device ${node.address}`);
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
                if (!_closed) node.emit('onJsonCMDSentError',
                  `Command failed: ${key}(${JSON.stringify(value)}) -> ${exception.message}`,
                  CustomJsonCMD);
              }
            }
            // Iter 3: try/catch on success-path destroy prevents double-destroy
            // if this throws and the outer catch also calls destroy().
            try { device.destroy(); } catch (_) {}
          } catch (exception) {
            if (!_closed) node.emit('onJsonCMDSentError', exception.message, CustomJsonCMD);
            try { device.destroy(); } catch (_) {}
          }
        });
      };
      node.on('onJsonCommand', _jsonCmdListener);
    }
  }

  RED.nodes.registerType('MIIOdevices', MIIOdevicesNode);
};
