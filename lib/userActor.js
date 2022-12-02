const Elf = require('./elf.js');

class Et extends Elf {
  alreadyCallHome = false;

  async create(id, desktopId) {
    this.do();
    return this;
  }

  async callTo(homeId) {
    if (this.elf.alreadyCallHome) {
      this.log.dbg(`The ship is comming`);
      return;
    }

    this.log.dbg(`E.T. phone home ${homeId}`);
    const home = await new Home(this).api(homeId);
    await home.dring();

    this.elf.alreadyCallHome = true;
  }
}

class Home extends Elf {
  static dringSkills = [];

  async create(id, desktopId) {
    this.do();
    return this;
  }

  async dring() {
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
