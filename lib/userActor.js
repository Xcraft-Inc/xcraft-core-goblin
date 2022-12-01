const Elf = require('./elf.js');

class Et extends Elf {
  static configure() {
    return Elf.configure(this);
  }

  async create(id, desktopId) {
    this.do();
  }

  async callTo(home) {
    this.log.dbg(`E.T. phone home ${home}`);
    const _home = this.getAPI(home);
    await _home.dring();
  }
}

class Home extends Elf {
  static configure() {
    return Elf.configure(this);
  }

  async create(id, desktopId) {
    this.do();
  }

  dring() {
    this.log.dbg('dring dring dring');
  }
}

class Universe extends Elf {
  static configure() {
    return Elf.configure(this);
  }

  async create(id, desktopId) {
    this.do();
  }

  async bigbang() {
    const home = await Home.create(this, 'home@toto', this.getDesktop());
    const et = await Et.create(this, 'et@toto', this.getDesktop());
    await et.callTo(home.id);
  }
}

/*************************************************/

module.exports = {
  Et,
  Home,
  Universe,
};
