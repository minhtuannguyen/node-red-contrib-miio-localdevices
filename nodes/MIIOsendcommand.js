'use strict';

module.exports = function(RED) {
  function MIIOsendcommandNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    node.config   = config;
    node.MIdevice = RED.nodes.getNode(config.devices);

    node.status({});

    // ── Listener / timer tracking ─────────────────────────────────────────────
    let _singleErrListener = null;
    let _singleErrTimer    = null;
    let _jsonErrListener   = null;
    let _jsonErrTimer      = null;
    let _statusTimer       = null;

    function setStatus(fill, shape, text, clearAfterMs) {
      clearTimeout(_statusTimer);
      node.status({ fill, shape, text });
      if (clearAfterMs) {
        _statusTimer = setTimeout(() => node.status({}), clearAfterMs);
      }
    }

    function clearSingleErr() {
      clearTimeout(_singleErrTimer);
      if (_singleErrListener && node.MIdevice) {
        node.MIdevice.removeListener('onSingleCMDSentError', _singleErrListener);
      }
      _singleErrListener = null;
      _singleErrTimer    = null;
    }

    function clearJsonErr() {
      clearTimeout(_jsonErrTimer);
      if (_jsonErrListener && node.MIdevice) {
        node.MIdevice.removeListener('onJsonCMDSentError', _jsonErrListener);
      }
      _jsonErrListener = null;
      _jsonErrTimer    = null;
    }

    node.on('close', () => {
      clearTimeout(_statusTimer);
      clearSingleErr();
      clearJsonErr();
    });

    // ── Input handler ─────────────────────────────────────────────────────────
    // Iter 12: 3-argument form (msg, send, done) for Node-RED 1.0+ compatibility.
    // send() is the correct way to forward messages; done() signals the runtime
    // that input processing is complete, enabling proper backpressure tracking.
    node.on('input', function(msg, send, done) {
      send = send || function() { node.send.apply(node, arguments); };
      done = done || function() {};

      // Iter R6: Check device config BEFORE setting status, so the node does
      // not get stuck showing 'Connecting...' when no device is configured.
      if (!node.MIdevice) {
        node.status({ fill: 'red', shape: 'ring', text: 'No device configured' });
        done();
        return;
      }

      setStatus('gray', 'dot', 'Connecting...');

      msg.name    = node.MIdevice.name + ' - ' + node.MIdevice.room;
      msg.address = node.MIdevice.address;
      msg.model   = node.MIdevice.model;

      if (node.config.command === 'Custom') {
        SendCustomJsonCMD();
      } else {
        SendSingleCMD();
      }

      function SendSingleCMD() {
        const SingleCMD     = node.config.command;
        const SinglePayload = msg.payload;

        clearSingleErr();

        _singleErrListener = (errMsg, errCmd) => {
          if (errCmd === SingleCMD) {
            // Iter 13: node.error() surfaces in the debug panel and can be
            // caught by a Catch node. node.warn() only writes to the log.
            node.error('Mihome Exception. IP: ' + node.MIdevice.address + ' -> ' + errMsg, msg);
            setStatus('red', 'ring', 'Command: error');
          }
          clearSingleErr();
        };
        node.MIdevice.once('onSingleCMDSentError', _singleErrListener);
        // Auto-clean listener after the timeout window even if no error fires.
        _singleErrTimer = setTimeout(clearSingleErr, 20000);

        node.MIdevice.emit('onSingleCommand', SingleCMD, SinglePayload);
        setStatus('green', 'dot', 'Command: sent', 5000);
        msg.payload = { [SingleCMD]: SinglePayload };
        send(msg);
        done();
      }

      function SendCustomJsonCMD() {
        const CustomJsonCMD = msg.payload;

        if (!CustomJsonCMD || typeof CustomJsonCMD !== 'object' || Array.isArray(CustomJsonCMD)) {
          node.error('Custom JSON command expects msg.payload to be an object like {"KeepWarmTemperature": 65}', msg);
          setStatus('red', 'ring', 'Command: error');
          done();
          return;
        }

        clearJsonErr();

        _jsonErrListener = (errMsg) => {
          node.error('Mihome Exception. IP: ' + node.MIdevice.address + ' -> ' + errMsg, msg);
          setStatus('red', 'ring', 'Command: error');
          clearJsonErr();
        };
        node.MIdevice.once('onJsonCMDSentError', _jsonErrListener);
        _jsonErrTimer = setTimeout(clearJsonErr, 20000);

        node.MIdevice.emit('onJsonCommand', CustomJsonCMD);
        setStatus('green', 'dot', 'Command: sent', 15000);
        msg.payload = CustomJsonCMD;
        send(msg);
        done();
      }
    });
  }

  RED.nodes.registerType('MIIOsendcommand', MIIOsendcommandNode);
};
