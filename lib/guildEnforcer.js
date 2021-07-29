const enforcer = {skills: new Set()};
module.exports = (coreGoblinConfig) => {
  const {Capability, SkillsSet} = require('./capsAndSkills.js');
  const path = require('path');
  const {appCompany, appData} = require('xcraft-core-host');
  const {mkdir} = require('fs-extra');
  const appConfigRoot = path.join(appData, appCompany);
  mkdir(appConfigRoot);
  const guildDefPath = path.join(appConfigRoot, coreGoblinConfig.guildsFile);
  //todo: read guild def file
  console.log(guildDefPath);
  //mock
  const guildsDef = {
    demoGuild: {
      id: 'guild@demo',
      members: [
        {
          id: 'guildUser@sam',
          login: 'loup@epsitec.ch',
          rank: 'master',
        },
      ],
    },
  };
  const ranksDef = {
    master: ['RUN_QUEST', 'CRESUS_USER'],
    guest: ['RUN_QUEST'],
    system: ['*'],
  };
  enforcer.guilds = guildsDef;
  enforcer.mainGuild = 'demoGuild';
  enforcer.ranks = ranksDef;

  /////////////////////////////////
  //shields protect quest from call
  const shielded = {};
  enforcer.shield = (cmd, quest, skills) => {
    const shield = {quest, skillsSet: SkillsSet.define(quest, skills)};
    shielded[cmd] = shield;
    return shield;
  };

  //////////////////////////////////////
  //helper for checking if a goblin
  //can run a command
  enforcer.isBlocked = (goblin, cmd) => {
    const shield = shielded[cmd];
    return !shield.skillsSet.isCapable(goblin);
  };

  enforcer.enforce = (object, rank) => {
    const caps = [];
    enforcer.ranks[rank].forEach((s) =>
      caps.push(Capability.create(object, Symbol.for(s)))
    );
    object.capabilities = caps;
  };

  ////////////////////////////////////////
  //users registry
  const users = {};
  for (const member of Object.values(guildsDef[enforcer.mainGuild].members)) {
    const user = {id: member.id, login: member.login, rank: member.rank};
    enforcer.enforce(user, member.rank);
    users[member.login] = user;
  }

  enforcer.users = users;

  enforcer.addGuestUser = (footprint) => {
    const user = {id: footprint, login: footprint, rank: 'guest'};
    enforcer.enforce(user, 'guest');
    users[footprint] = user;
  };
  return Object.freeze(enforcer);
};
