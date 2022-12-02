const Elf = require('./elf.js');

class Et extends Elf {
  async create(id, desktopId) {
    this.do();
    return this;
  }

  async callTo(homeId) {
    this.log.dbg(`E.T. phone home ${homeId}`);
    const _home = this.getAPI(homeId);
    await _home.dring();
  }
}

class Home extends Elf {
  async create(id, desktopId) {
    this.do();
    return this;
  }

  static dringSkills = [];
  dring() {
    this.log.dbg('dring dring dring');
  }
}

class Universe extends Elf {
  async create(id, desktopId) {
    this.do();
    return this;
  }

  async bigbang() {
    const home = await new Home(this).create('home@toto', this.getDesktop());
    const et = await new Et(this).create('et@toto', this.getDesktop());
    await et.callTo(home.id);
  }
}

/*************************************************/

module.exports = {
  Et,
  Home,
  Universe,
};
