'use strict';

module.exports = function(RED) {
  function MIIOsendcommandNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    node.config   = config;
    node.MIdevice = RED.nodes.getNode(config.devices);

    node.status({});

    // ── Listener / timer tracking ─────────────────────────────────────────────
    // .once() listeners for command errors must be removed when:
    //   • the command succeeds (error never fires) — otherwise they pile up
    //   • the node closes
    // We store a reference to the current listener so the previous one is
    // always removed before a new one is added.
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
    node.on('input', function(msg) {
      setStatus('gray', 'dot', 'Connecting...');

      if (!node.MIdevice) return;

      msg.name    = node.MIdevice.name + ' - ' + node.MIdevice.room;
      msg.address = node.MIdevice.address;
      msg.model   = node.MIdevice.model;

      if (node.config.command === 'Custom') {
        SendCustomJsonCMD();
      } else {
        SendSingleCMD();
      }

      function SendSingleCMD() {
        const SingleCMD     = node.config.command;  // local — no global leak
        const SinglePayload = msg.payload;           // local — no global leak

        // Remove previous unfired listener before registering a new one.
        clearSingleErr();

        _singleErrListener = (errMsg, errCmd) => {
          if (errCmd === SingleCMD) {
            node.warn(`Mihome Exception. IP: ${node.MIdevice.address} -> ${errMsg}`);
            setStatus('red', 'ring', 'Command: error');
          }
          clearSingleErr();
        };
        node.MIdevice.once('onSingleCMDSentError', _singleErrListener);
        // Remove listener after the device timeout window even if no error fires,
        // so successful commands don't leave a dangling listener indefinitely.
        _singleErrTimer = setTimeout(clearSingleErr, 20000);

        node.MIdevice.emit('onSingleCommand', SingleCMD, SinglePayload);
        setStatus('green', 'dot', 'Command: sent', 5000);
        msg.payload = { [SingleCMD]: SinglePayload };
        node.send(msg);
      }

      function SendCustomJsonCMD() {
        const CustomJsonCMD = msg.payload;  // local — no global leak

        if (!CustomJsonCMD || typeof CustomJsonCMD !== 'object' || Array.isArray(CustomJsonCMD)) {
          node.warn('Custom JSON command expects msg.payload to be an object like {"KeepWarmTemperature": 65}');
          setStatus('red', 'ring', 'Command: error');
          return;
        }

        // Remove previous unfired listener before registering a new one.
        clearJsonErr();

        _jsonErrListener = (errMsg) => {
          node.warn(`Mihome Exception. IP: ${node.MIdevice.address} -> ${errMsg}`);
          setStatus('red', 'ring', 'Command: error');
          clearJsonErr();
        };
        node.MIdevice.once('onJsonCMDSentError', _jsonErrListener);
        _jsonErrTimer = setTimeout(clearJsonErr, 20000);

        node.MIdevice.emit('onJsonCommand', CustomJsonCMD);
        setStatus('green', 'dot', 'Command: sent', 15000);
        msg.payload = CustomJsonCMD;
        node.send(msg);
      }
    });
  }

  RED.nodes.registerType('MIIOsendcommand', MIIOsendcommandNode);
};
