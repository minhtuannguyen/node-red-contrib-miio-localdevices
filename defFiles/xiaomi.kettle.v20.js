const Device = require('../device-miio');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = class extends Device {
  static model = 'xiaomi.kettle.v20';
  static name = 'Xiaomi Kettle (v20)';

  constructor(opts) {
    super(opts);

    this._miotSpecType = 'urn:miot-spec-v2:device:kettle:0000A009:xiaomi-v20:1';
    this._propertiesToMonitor = [
      // Core kettle service
      'kettle:status',
      'kettle:temperature',
      'kettle:target-temperature',
      'kettle:keep-warm-temperature',
      'kettle:auto-keep-warm',
      'kettle:on',

      // Function service (xiaomi-spec)
      'function:warming-time',
      'function:keep-warm-time',
      'function:target-mode',
      'function:custom-knob-temp',
      'function:lift-remember-temp',
      'function:boiling-reminder',
      'function:keep-warm-reminder',
      'function:kettle-lifting',

      // No disturb service
      'no-disturb:no-disturb',
    ];
  }

  setPower(v) {
    return this.miotSetProperty('kettle:on', v);
  }

  setAutoKeepWarm(v) {
    return this.miotSetProperty('kettle:auto-keep-warm', v);
  }

  setNoDisturb(v) {
    return this.miotSetProperty('no-disturb:no-disturb', v);
  }

  setCustomKnobTemp(v) {
    return this.miotSetProperty('function:custom-knob-temp', v);
  }

  setLiftRememberTemp(v) {
    return this.miotSetProperty('function:lift-remember-temp', v);
  }

  setBoilingReminder(v) {
    return this.miotSetProperty('function:boiling-reminder', v);
  }

  setKeepWarmReminder(v) {
    return this.miotSetProperty('function:keep-warm-reminder', v);
  }

  setTargetTemperature(v) {
    // Spec: 40-99 °C
    if (v >= 40 && v <= 99) {
      return this.miotSetProperty('kettle:target-temperature', v);
    }
    return Promise.reject(new Error(`Invalid target temperature: ${v}. Should be between 40 and 99`));
  }

  setKeepWarmTemperature(v) {
    // Spec: 0-100 °C
    if (v >= 0 && v <= 100) {
      return this.miotSetProperty('kettle:keep-warm-temperature', v);
    }
    return Promise.reject(new Error(`Invalid keep-warm temperature: ${v}. Should be between 0 and 100`));
  }

  setKeepWarmTime(v) {
    // Spec: 60-1440 minutes
    if (v >= 60 && v <= 1440) {
      return this.miotSetProperty('function:keep-warm-time', v);
    }
    return Promise.reject(new Error(`Invalid keep-warm time: ${v}. Should be between 60 and 1440 (minutes)`));
  }

  setTargetMode(v) {
    // Spec: 0-128
    if (v >= 0 && v <= 128) {
      return this.miotSetProperty('function:target-mode', v);
    }
    return Promise.reject(new Error(`Invalid target mode: ${v}. Should be between 0 and 128`));
  }

  async setStopWork(_) {
    // MIoT action: service iid 3 (function), action iid 1 (stop-work)
    const did = this.id;
    const res = await this.send('action', [{
      did,
      siid: 3,
      aiid: 1,
      in: [],
    }]);

    if (!res || !res[0] || res[0].code !== 0) {
      throw new Error('Could not perform operation');
    }

    await sleep(50);
    await this.loadProperties();

    return res[0];
  }
};
