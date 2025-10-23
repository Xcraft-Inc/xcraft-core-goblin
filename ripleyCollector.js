const {Elf} = require('xcraft-core-goblin');
const {RipleyCollector} = require('./lib/ripleyCollector.js');

exports.xcraftCommands = Elf.birth(RipleyCollector);
