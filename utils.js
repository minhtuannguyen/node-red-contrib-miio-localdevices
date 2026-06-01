/**
 * Wraps a value or array with light effect parameters for Yeelight devices.
 * Converts single values to an array format expected by miioCall.
 * 
 * @param {*} value - The value to wrap (can be a single value or array)
 * @returns {Array} - The value wrapped in an array if it's not already an array
 */
function withLightEffect(value) {
    if (Array.isArray(value)) {
        return value;
    }
    return [value];
}

module.exports = {
    withLightEffect,
};
