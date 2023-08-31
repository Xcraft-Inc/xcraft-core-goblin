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
//
// policies.json:
// defaultSystemUserId <- identifiant secret du user system
// enroling by claims:
// [claim]: {
//   [value]:[grantedRank]
// }
//

const ShieldUsers = require('./shield/db.js');

class ShieldedError extends Error {
  constructor(subject, ...params) {
    super(subject, ...params);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ShieldedError);
    }
    this.name = 'ShieldedError';
    if (!this.message) {
      this.message = 'blocked';
    }
    this.subject = subject;
    this.date = new Date();
  }
}

const enforcer = {skills: new Set()};
let usersCacheDir;
module.exports = (busConfig, goblinConfig) => {
  const enableCache = goblinConfig?.enableGuildEnforcerCache || false;
  const path = require('path');
  const {readJSONSync, mkdirpSync} = require('fs-extra');

  const {
    appCompany,
    appData,
    variantId,
    appMasterId,
    appId,
  } = require('xcraft-core-host');
  const cleanupNeeded = appId === appMasterId;

  //if not done previously
  if (enableCache && !usersCacheDir) {
    //prepare and cleanup shared users cache

    let appFolder = appMasterId;
    if (variantId) {
      appFolder = `${appMasterId}-${variantId}`;
    }
    const storagePath = path.join(appData, appCompany, appFolder);
    const usersPath = path.join(storagePath, 'guildEnforcer', 'users');

    if (cleanupNeeded) {
      mkdirpSync(usersPath);
    }

    //set as initialised
    usersCacheDir = usersPath;
  }

  const {Capability, SkillsSet} = require('./capsAndSkills.js');
  const {resourcesPath} = require('xcraft-core-host');

  let policies;
  if (busConfig) {
    const policiesJSONFile = path.join(resourcesPath, busConfig.policiesPath);
    policies = readJSONSync(policiesJSONFile, {throws: false});
  }

  const shieldRefresh = (id, login, rank, createAt, member) => {
    if (!enforcer.enforce) {
      return;
    }

    const lastAccess = Date.now();
    const user = {
      id,
      login,
      rank,
      lastAccess,
      createAt,
      member,
    };
    enforcer.enforce(user, user.rank);
    users[id] = user;
  };

  const usersDB = enableCache
    ? new ShieldUsers(
        usersCacheDir,
        shieldRefresh,
        shieldRefresh,
        shieldRefresh
      )
    : null;

  const getUserInCache = (id) => (usersDB ? usersDB.get(id) : null);
  const saveUser = (id, data) => usersDB && usersDB.save(id, data);
  const deleteUser = (id) => usersDB && usersDB.delete(id);

  /* Cleanup only if we are the master app
   * Note that when two master apps (same appId) are open, the second
   * app deletes the content. It should not matter since it's just a
   * cache.
   */
  if (usersDB && cleanupNeeded) {
    usersDB.deleteAll();
  }

  const defaultSystemUser = {
    id: 'defaultSystemUser',
    login: 'system@xcraft.ch',
    rank: 'system',
  };

  // base def used in scope:
  let members;
  let ranks;
  let enroleByClaims;
  if (policies) {
    //todo: checkup imported policies
    members = policies.members;
    ranks = policies.ranks;
    enroleByClaims = policies.enroleByClaims;
    if (policies) {
      members.push({
        id: policies.defaultSystemUserId || defaultSystemUser.id,
        login: policies.defaultSystemUserLogin || defaultSystemUser.login,
        rank: policies.defaultSystemUserRank || defaultSystemUser.rank,
      });
    } else {
      members.push(defaultSystemUser);
    }
  } else {
    let lvl = busConfig?.defaultPolicyLevel ?? 0;
    //lvl
    //0: allow system to run all (bad defaults)
    //1: enroled via auth token only
    const defaultRanks = {};
    switch (lvl) {
      case 0:
        defaultRanks.system = ['*'];
        defaultRanks.guest = ['*'];
        break;
      case 1:
        defaultRanks.system = ['*'];
        defaultRanks.guest = [];
        defaultRanks.authentified = ['*'];
        break;
    }

    const def = {
      members: [defaultSystemUser],
      enroleByClaims: {
        aud: {goblins: 'authentified'},
      },
      ranks: {
        ...defaultRanks,
      },
    };
    members = def.members;
    ranks = def.ranks;
    enroleByClaims = def.enroleByClaims;
  }

  /////////////////////////////////
  // Predictions is a
  // cmd <-> role mapping for preventing
  // blocked actions
  const predictions = {};
  const predict = (cmd) => {
    for (const rank of Object.keys(ranks)) {
      const tempRef = {id: 'tempRef'};
      enforcer.enforce(tempRef, rank);
      if (!predictions[cmd]) {
        predictions[cmd] = {};
      }
      predictions[cmd][rank] = enforcer.isBlocked(tempRef, cmd);
    }
  };

  enforcer.getRankingPredictions = (cmd) => predictions[cmd];

  /////////////////////////////////
  //shields protect quest from call
  const shielded = {};
  enforcer.shield = (cmd, quest, skills) => {
    const shield = {quest, skillsSet: SkillsSet.define(quest, skills)};
    shielded[cmd] = shield;
    predict(cmd);
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
  const users = {};

  //cleanup non-member user (guest) every minutes
  const cleanupInterval = setInterval(() => {
    const timestamp = Date.now();
    for (const [key, user] of Object.entries(users)) {
      if (
        user.member === false &&
        user.lastAccess &&
        user.lastAccess + 300000 < parseInt(timestamp)
      ) {
        //todo: use bus log
        console.log(
          'deleting non active user:',
          user.login,
          'last access: ',
          new Date(user.lastAccess).toUTCString()
        );
        delete users[key];
      }
    }
  }, 60000);

  for (const member of Object.values(members)) {
    const user = {
      id: member.id,
      login: member.login,
      rank: member.rank,
      createdAt: Date.now(),
      lastAccess: null,
      member: true,
      canDo: (cmd) => {
        const isBlocked = predictions[cmd]
          ? predictions[cmd][member.rank]
          : true;
        return !isBlocked;
      },
    };
    enforcer.enforce(user, member.rank);
    users[member.id] = user;
    saveUser(member.id, user);
  }

  enforcer.users = users;

  enforcer.addGuestUser = (footprint) => {
    const user = {
      id: footprint,
      login: footprint,
      rank: 'guest',
      createdAt: Date.now(),
      lastAccess: Date.now(),
      member: false,
      canDo: (cmd) => {
        const isBlocked = predictions[cmd] ? predictions[cmd]['guest'] : true;
        return !isBlocked;
      },
    };
    enforcer.enforce(user, 'guest');
    users[footprint] = user;
  };

  enforcer.deroleUser = (tokenData) => {
    const {sub} = tokenData;
    delete users[sub];
    deleteUser(sub);
  };

  enforcer.enroleUser = (tokenData) => {
    const id = tokenData.sub;
    const login = tokenData.login;
    let rank = 'denied';
    let fallbackRank = null;
    //try to get a rank from claims
    for (const [claim, value] of Object.entries(tokenData)) {
      if (enroleByClaims[claim] && enroleByClaims[claim][value]) {
        // the `aud` claim is standard OAuth2 and it's used here
        // as fallback.
        if (claim === 'aud') {
          fallbackRank = enroleByClaims[claim][value];
        } else {
          rank = enroleByClaims[claim][value];
        }
      }
    }
    //fail if nothing match
    if (rank === 'denied') {
      if (!fallbackRank) {
        throw new Error(`Cannot enrole ${login}`);
      }
      rank = fallbackRank;
    }
    const user = {
      id,
      login: login,
      rank,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      member: true,
    };
    enforcer.enforce(user, rank);
    users[id] = user;
    saveUser(id, user);
    return user.rank;
  };

  enforcer.getUser = (userId) => {
    const user = users[userId];
    if (user) {
      return user;
    }

    //lookup in cache
    const userInCache = getUserInCache(userId);
    if (!userInCache) {
      return null;
    }
    userInCache.lastAccess = Date.now();
    enforcer.enforce(userInCache, userInCache.rank);
    users[userId] = userInCache;
    return userInCache;
  };

  enforcer.dispose = () => clearInterval(cleanupInterval);

  if (process.env.GOBLIN_ENFORCER_LOOSE) {
    return enforcer;
  }
  return Object.freeze(enforcer);
};
