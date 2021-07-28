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
        {id: 'guildUser@guest', login: 'guest', rank: 'guest'},
      ],
    },
  };
  const ranksDef = {
    master: ['RUN_QUEST', 'OPEN_DESKTOP'],
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
    const user = {id: member.id};
    enforcer.enforce(user, member.rank);
    users[member.login] = user;
  }
  enforcer.users = users;
  return Object.freeze(enforcer);
};
