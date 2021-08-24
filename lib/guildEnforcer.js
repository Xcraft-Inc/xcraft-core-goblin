///////////////////////////////////////////////////////////////////////////////
// GUILD ENFORCER
// SamLeBarbare, Août 2021
//
// Principes:
// chaque instances core-goblin dispose de son api de sécurité "guildEnforcer"
//
// Lors du require initial de core-goblin, on prépare la politique de sécurité
// la présence d'un fichier de définition de la politique de sécurité permet
// de définir les régles de bases.
//
// Si aucune régles ne sont spécifiée, on utilisera une politique initiale
// qui utilise les jetons JWT pour identifier et définir "rank"
// de capacité de l'utilisateur pour ce noeud.
//
// Un utilisateur non identifié est considéré avec un "rank" de niveau invité.
//
// Toute quête appelée est attribuée à un utilisateur, lors de cette attribution
// on identifie l'utilisateur à l'aide de la propriété _goblinUser présente
// dans le message en provenance du bus.
//
// le _goblinUser ne dois pas remonter par evt chez d'autres clients du bus.
//
// Les points d'injection du goblinUser sont sensibles, la propagation par
// commande, voir par événements doit être effectuée par le framework.
//
// si la propriété est manquante on enregistre l'empreinte de l'utilisateur
// ayant emis le message, on ajoute l'utilisateur comme invité et on enregistre
// son activité.
//
// Les acteurs goblins peuvent être déclaré avec un "rank" spécifique
// Chaque appel d'une instance à une autre est vérifié.
//
// Si le niveau de privilège est insuffisant, l'appel échoue par une ShieledError

class ShieldedError extends Error {
  constructor(subject, ...params) {
    super(...params);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ShieldedError);
    }
    this.name = 'ShieldedError';
    this.message = 'blocked';
    this.subject = subject;
    this.date = new Date();
  }
}
const enforcer = {skills: new Set()};
module.exports = (coreGoblinConfig) => {
  const {Capability, SkillsSet} = require('./capsAndSkills.js');
  const path = require('path');
  const {appCompany, appData} = require('xcraft-core-host');
  const {mkdir, readJSONSync} = require('fs-extra');
  const appConfigRoot = path.join(appData, appCompany);
  mkdir(appConfigRoot);
  const guildDefPath = path.join(appConfigRoot, coreGoblinConfig.guildsFile);
  console.log(guildDefPath);
  const guildDefJSON = readJSONSync(guildDefPath, {throws: false});

  // base def used in scope:
  let members;
  let ranks;
  let enroleByClaims;
  if (guildDefJSON) {
    console.dir(guildDefJSON);
    //todo: verify def
    const def = {
      members: [
        {
          id: 'guildUser@sam1',
          login: 'loup@epsitec.ch',
          rank: 'master',
        },
      ],
      //mapping between JWT claims and ranks
      enroleByClaims: {
        //jwt claim: {claim value: rank}
        aud: {'cresus.ch': 'user'},
        nautilusAdmin: {read: 'user', full: 'master'},
      },
      ranks: {
        master: [
          'RUN_QUEST',
          'OPEN_DESKTOP',
          'SETUP_MANDATE',
          'READ_WILLIAM',
          'WRITE_WILLIAM',
        ],
        user: ['RUN_QUEST', 'OPEN_DESKTOP'],
        guest: ['RUN_QUEST'],
        system: ['*'], //allow system to run all (bad defaults)}
      },
    };
    members = def.members;
    ranks = def.ranks;
    enroleByClaims = def.enroleByClaims;
  } else {
    //todo: better defaults
    const def = {
      members: [],
      enroleByClaims: {
        aud: {'cresus.ch': 'user'},
      },
      ranks: {
        admin: ['RUN_QUEST', 'OPEN_DESKTOP', 'SETUP_MANDATE'],
        user: ['RUN_QUEST', 'OPEN_DESKTOP'],
        guest: ['RUN_QUEST'],
        system: ['*'], //allow system to run all (bad defaults)}
      },
    };
    members = def.members;
    ranks = def.ranks;
    enroleByClaims = def.enroleByClaims;
  }

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

  enforcer.ShieldedError = ShieldedError;

  enforcer.enforce = (object, rank) => {
    const caps = [];
    ranks[rank].forEach((s) =>
      caps.push(Capability.create(object, Symbol.for(s)))
    );
    object.capabilities = caps;
  };

  ////////////////////////////////////////
  //users registry
  const users = new Proxy(
    {},
    {
      get: (me, key) => {
        const user = me[key];
        if (user) {
          user.lastAccess = Date.now();
          return user;
        } else {
          return undefined;
        }
      },
    }
  );

  for (const member of Object.values(members)) {
    const user = {
      id: member.id,
      login: member.login,
      rank: member.rank,
      createdAt: Date.now(),
      lastAccess: null,
    };
    enforcer.enforce(user, member.rank);
    users[member.login] = user;
  }

  enforcer.users = users;

  enforcer.addGuestUser = (footprint) => {
    const user = {
      id: footprint,
      login: footprint,
      rank: 'guest',
      createdAt: Date.now(),
      lastAccess: Date.now(),
    };
    enforcer.enforce(user, 'guest');
    users[footprint] = user;
  };

  enforcer.enroleUser = (tokenData) => {
    const login = tokenData.login;
    let rank = 'denied';
    //try to get a rank from claims
    for (const [claim, value] of Object.entries(tokenData)) {
      if (enroleByClaims[claim] && enroleByClaims[claim][value]) {
        rank = enroleByClaims[claim][value];
      }
    }
    //fail if nothing match
    if (rank === 'denied') {
      throw new Error(`Cannot enrole ${login}`);
    }
    const user = {
      id: login,
      login: login,
      rank,
      createdAt: Date.now(),
      lastAccess: Date.now(),
    };
    enforcer.enforce(user, rank);
    users[login] = user;
  };
  return Object.freeze(enforcer);
};
