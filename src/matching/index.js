const text = require("./text");
const engine = require("./engine");
const sold = require("./sold");
const candidates = require("./candidates");

module.exports = { ...text, ...engine, ...sold, ...candidates };
