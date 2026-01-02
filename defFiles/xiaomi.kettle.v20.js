// xiaomi.kettle.v20.js
// Device definition for Xiaomi Kettle v20 (xiaomi.kettle.v20)
// Extracted and adapted from hass-xiaomi-miot and issue #2369

module.exports = class KettleV20 {
    constructor(miioDev) {
        this.miioDev = miioDev;
        this._miotSpecType = 'urn:miot-spec-v2:device:kettle:0000A059:xiaomi-v20:1';
    }

    // Status: SIID 2, PIID 1
    async getStatus() {
        // 0: Idle, 1: Heating, 2: Boiling, 3: Cooling, 4: Keep Warm
        return this.miioDev.miotGetProperty({siid:2, piid:1});
    }

    // Temperature: SIID 2, PIID 5
    async getTemperature() {
        // Current temperature in °C
        return this.miioDev.miotGetProperty({siid:2, piid:5});
    }

    // Target Temperature: SIID 2, PIID 4
    async getTargetTemperature() {
        // Set target temperature (40-90°C)
        return this.miioDev.miotGetProperty({siid:2, piid:4});
    }

    async setTargetTemperature(temp) {
        // Set target temperature (40-90°C)
        return this.miioDev.miotSetProperty({siid:2, piid:4}, temp);
    }

    // Error: SIID 2, PIID 2
    async getError() {
        // 0: No error
        return this.miioDev.miotGetProperty({siid:2, piid:2});
    }
};
