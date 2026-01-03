const Device = require('../device-miio');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = class extends Device {
  static model = 'careli.fryer.maf07';
  static name = 'Careli Air Fryer (maf07)';

  constructor(opts) {
    super(opts);

    this._miotSpecType = 'urn:miot-spec-v2:device:air-fryer:0000A0A4:careli-maf07:1';
    this._propertiesToMonitor = [
      // Air Fryer service
      'air-fryer:status',
      'air-fryer:fault',
      'air-fryer:target-time',
      'air-fryer:target-temperature',
      'air-fryer:left-time',

      // Custom service
      'custom:recipe-id',
      'custom:appoint-time',
      'custom:appoint-time-left',
      'custom:food-quanty',
      'custom:preheat-switch',
      'custom:turn-pot',
    ];
  }

  // --- Writable properties ---

  setTargetTime(v) {
    // Spec: 1-1440 minutes
    if (typeof v === 'number' && v >= 1 && v <= 1440) {
      return this.miotSetProperty('air-fryer:target-time', v);
    }
    return Promise.reject(new Error(`Invalid target time: ${v}. Should be between 1 and 1440 (minutes)`));
  }

  setTargetTemperature(v) {
    // Spec: 40-200 °C
    if (typeof v === 'number' && v >= 40 && v <= 200) {
      return this.miotSetProperty('air-fryer:target-temperature', v);
    }
    return Promise.reject(new Error(`Invalid target temperature: ${v}. Should be between 40 and 200`));
  }

  setWorkTime(v) {
    // Spec: 1-1440 minutes (write-only)
    if (typeof v === 'number' && v >= 1 && v <= 1440) {
      return this.miotSetProperty('custom:work-time', v);
    }
    return Promise.reject(new Error(`Invalid work time: ${v}. Should be between 1 and 1440 (minutes)`));
  }

  setWorkTemp(v) {
    // Spec: 40-200 °C (write-only)
    if (typeof v === 'number' && v >= 40 && v <= 200) {
      return this.miotSetProperty('custom:work-temp', v);
    }
    return Promise.reject(new Error(`Invalid work temperature: ${v}. Should be between 40 and 200`));
  }

  setRecipeId(v) {
    if (v === undefined || v === null) {
      return Promise.reject(new Error('Invalid recipe id: value is required'));
    }
    return this.miotSetProperty('custom:recipe-id', String(v));
  }

  setAppointTime(v) {
    // Spec: 0-1440 minutes
    if (typeof v === 'number' && v >= 0 && v <= 1440) {
      return this.miotSetProperty('custom:appoint-time', v);
    }
    return Promise.reject(new Error(`Invalid appoint time: ${v}. Should be between 0 and 1440 (minutes)`));
  }

  setAppointTimeLeft(v) {
    // Spec: 0-1440 minutes
    if (typeof v === 'number' && v >= 0 && v <= 1440) {
      return this.miotSetProperty('custom:appoint-time-left', v);
    }
    return Promise.reject(new Error(`Invalid appoint time left: ${v}. Should be between 0 and 1440 (minutes)`));
  }

  setFoodQuanty(v) {
    // Enum: 0 Null, 1 Single, 2 Double, 3 Half, 4 Full
    const map = {
      null: 0,
      single: 1,
      double: 2,
      half: 3,
      full: 4,
    };

    let value = v;
    if (typeof v === 'string') {
      const k = v.trim().toLowerCase();
      if (k in map) value = map[k];
    }

    if (typeof value === 'number' && value >= 0 && value <= 4) {
      return this.miotSetProperty('custom:food-quanty', value);
    }

    return Promise.reject(
      new Error(`Invalid food quanty: ${v}. Allowed values: 0-4 or one of ${Object.keys(map).join(', ')}`),
    );
  }

  setPreheatSwitch(v) {
    // Enum: 0 Null, 1 Off, 2 On
    let value = v;

    if (typeof v === 'boolean') {
      value = v ? 2 : 1;
    } else if (typeof v === 'string') {
      const k = v.trim().toLowerCase();
      if (k === 'on' || k === 'true') value = 2;
      if (k === 'off' || k === 'false') value = 1;
      if (k === 'null') value = 0;
    }

    if (value === 0 || value === 1 || value === 2) {
      return this.miotSetProperty('custom:preheat-switch', value);
    }

    return Promise.reject(new Error(`Invalid preheat switch: ${v}. Allowed values: 0 (Null), 1 (Off), 2 (On)`));
  }

  setTurnPot(v) {
    // Enum: 0 Not Turn Pot, 1 Switch Off, 2 Turn Pot
    let value = v;

    if (typeof v === 'boolean') {
      value = v ? 2 : 0;
    } else if (typeof v === 'string') {
      const k = v.trim().toLowerCase();
      if (k === 'on' || k === 'true' || k === 'turn') value = 2;
      if (k === 'off' || k === 'false' || k === 'noturn' || k === 'no') value = 0;
    }

    if (value === 0 || value === 1 || value === 2) {
      return this.miotSetProperty('custom:turn-pot', value);
    }

    return Promise.reject(new Error(`Invalid turn pot: ${v}. Allowed values: 0, 1, 2`));
  }

  // --- Actions ---

  async _miotAction(siid, aiid) {
    const did = this.id;
    const res = await this.send('action', [
      {
        did,
        siid,
        aiid,
        in: [],
      },
    ]);

    if (!res || !res[0] || res[0].code !== 0) {
      throw new Error('Could not perform operation');
    }

    await sleep(50);
    await this.loadProperties();

    return res[0];
  }

  async setStartCook(_) {
    // service 2 (air-fryer), action 1 (start-cook)
    return this._miotAction(2, 1);
  }

  async setCancelCooking(_) {
    // service 2 (air-fryer), action 2 (cancel-cooking)
    return this._miotAction(2, 2);
  }

  async setPause(_) {
    // service 2 (air-fryer), action 3 (pause)
    return this._miotAction(2, 3);
  }

  async setStartCustomCook(_) {
    // service 3 (custom), action 1 (start-custom-cook)
    return this._miotAction(3, 1);
  }

  async setResumeCooking(_) {
    // service 3 (custom), action 2 (resume-cooking)
    return this._miotAction(3, 2);
  }
};
