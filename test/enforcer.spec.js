'use strict';
const {expect} = require('chai');

describe('guild-enforcer', function () {
  let guildEnforcer;

  before(function () {
    guildEnforcer = require('../lib/guildEnforcer.js')({
      policiesPath: '',
      defaultPolicyLevel: 1,
    });
    const quest = () => {
      return 'hello world';
    };
    const OPEN_DESKTOP = Symbol.for('OPEN_DESKTOP');
    guildEnforcer.shield('test-cmd', quest, [OPEN_DESKTOP]);
  });

  it('block not enforced', function () {
    const userOne = {id: 'one'};
    const blocked = guildEnforcer.isBlocked(userOne, 'test-cmd');
    expect(blocked).to.be.equal(true);
  });

  it('enforced as guest must be blocked', function () {
    const userOne = {id: 'one'};
    guildEnforcer.enforce(userOne, 'guest');
    const blocked = guildEnforcer.isBlocked(userOne, 'test-cmd');
    expect(blocked).to.be.equal(true);
  });

  it('enforced as authentified must be allowed', function () {
    const userOne = {id: 'one'};
    guildEnforcer.enforce(userOne, 'authentified');
    const blocked = guildEnforcer.isBlocked(userOne, 'test-cmd');
    expect(blocked).to.be.equal(false);
  });

  it('add guest from footprint', function () {
    const footprint = 'userOne@host@test@unit';
    guildEnforcer.addGuestUser(footprint);
    const user = guildEnforcer.users[footprint];
    expect(user.login).to.be.equal(footprint);
  });

  it('guest from footprint must be blocked', function () {
    const footprint = 'userOne@host@test@unit';
    const user = guildEnforcer.users[footprint];
    const blocked = guildEnforcer.isBlocked(user, 'test-cmd');
    expect(blocked).to.be.equal(true);
  });

  it('enrole user from token', function () {
    const token = {sub: 'uid.test', aud: 'goblins', login: 'userOne@host.ch'};
    guildEnforcer.enroleUser(token);
    const user = guildEnforcer.users['userOne@host.ch'];
    expect(user.login).to.be.equal('userOne@host.ch');
  });

  it('enroled user must be allowed', function () {
    const user = guildEnforcer.users['userOne@host.ch'];
    const blocked = guildEnforcer.isBlocked(user, 'test-cmd');
    expect(blocked).to.be.equal(false);
  });
});
