// @ts-check
const {Elf} = require('xcraft-core-goblin');
const {id} = require('xcraft-core-goblin/lib/types.js');
const {string} = require('xcraft-core-stones');

class SimpleElfShape {
  id = id('simpleElf');
  value = string;
}

class SimpleElfState extends Elf.Sculpt(SimpleElfShape) {}

class SimpleElfLogic extends Elf.Archetype {
  static db = 'chest';
  static indices = ['id', 'name', 'generation'];
  state = new SimpleElfState();

  create(id, value) {
    const {state} = this;
    state.id = id;
    state.value = value;
  }

  update(value) {
    const {state} = this;
    state.value = value;
  }
}

class SimpleElf extends Elf {
  logic = Elf.getLogic(SimpleElfLogic);
  state = new SimpleElfState();

  async create(id, desktopId, value) {
    this.logic.create(id, value);
    return this;
  }

  async update(value) {
    this.logic.update(value);
  }
}

module.exports = {
  SimpleElf,
  SimpleElfLogic,
  SimpleElfShape,
  xcraftCommands: Elf.birth(SimpleElf, SimpleElfLogic),
};
