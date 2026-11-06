# 📘 xcraft-core-goblin

> Goblins are small, green (or yellow-green) creatures with pointy features and high intelligence (though often little common sense). Goblins speak Goblin, Orcish, and Common. Goblins know myriad languages in order to trade with as many races as possible.

## Aperçu

Le module `xcraft-core-goblin` est le cœur du framework Xcraft. Il fournit une API pour composer des microservices appelés « acteurs », basés sur un store Redux et un état immutable. Deux modèles d'acteurs coexistent :

- **Goblin** (legacy) : acteurs sans classe, définis par des quêtes (fonctions ou générateurs) et des reducers Redux.
- **Elf** (moderne) : acteurs sous forme de classes proxifiées. Les quêtes sont des méthodes de classe, et l'état est décrit par des shapes typées.

Le module gère aussi :

- la persistance et la synchronisation distribuée des états via Ripley et [xcraft-core-cryo] ;
- la sécurité (Guild Enforcer) ;
- un cache d'instances avec TTL et ranking ;
- des constructeurs d'applications, de files d'attente et de workers.

Une documentation présentant les acteurs Elf pas à pas est disponible sur le site Xcraft : https://xcraft.ch/elves/

## Sommaire

- [Structure du module](#structure-du-module)
- [Fonctionnement global](#fonctionnement-global)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Interactions avec d'autres modules](#interactions-avec-dautres-modules)
- [Configuration avancée](#configuration-avancée)
- [Détails des sources](#détails-des-sources)
- [Licence](#licence)

## Structure du module

Le module s'organise autour des composants suivants :

- **Goblin** (`lib/index.js`) : classe principale du système d'acteurs, registre des quêtes, des instances et des configurations.
- **Elf** (`lib/elf/`) : acteurs modernes avec proxies (`traps`), états typés (`Spirit`, `List`), wrapper `Me` et runner de tests.
- **Quest** (`lib/quest.js`) : contexte d'exécution fourni à chaque quête.
- **Scheduler** (`lib/scheduler.js`, `lib/scheduler-queue.js`) : files d'attente d'exécution des quêtes (immediate, serie, parallel).
- **GuildEnforcer** (`lib/guildEnforcer.js`, `lib/capsAndSkills.js`, `lib/shield/db.js`) : contrôle d'accès par capacités, rôles et compétences.
- **Ripley** (`lib/ripley.js`, `lib/ripley/cryo.js`, `lib/ripleySync.js`) : persistance des actions Redux et synchronisation client/serveur.
- **Sync** (`lib/sync/`) : orchestration de la synchronisation incrémentale et du bootstrap entre nœuds.
- **Cryo** (`lib/cryo/`) : lecture, recherche (FTS5, vectorielle) et requêtes typées sur les bases SQLite de Cryo.
- **Cache** (`lib/cache/`) : acteur `goblin-cache` pour le TTL et l'éviction des instances.
- **Builders** (`lib/appBuilder.js`, `lib/queueBuilder.js`, `lib/workerBuilder.js`) : applications, files d'attente et workers.
- **Services racine** : `goblin.js` (service principal), `goblin-cache.js`, `goblin-orc.js` et `goblin-registry.js` exposent leurs commandes sur le bus via `xcraftCommands`.

## Fonctionnement global

### Architecture des acteurs

1. **Acteurs Goblin (legacy)** : on enregistre des quêtes avec `Goblin.registerQuest`, puis on déclare l'état initial et les reducers avec `Goblin.configure`. Une quête appelle `quest.do()` pour déclencher le reducer du même nom (pattern Redux).
2. **Acteurs Elf** : une classe héritant de `Elf` (instanciable) ou `Elf.Alone` (singleton) est associée à une classe de logique (`Elf.Archetype` si l'état est persisté, sinon `Elf.Spirit`). `Elf.birth` enregistre la classe, et `Elf.configure` convertit ses méthodes en quêtes et les méthodes de la logique en reducers.

Chaque instance possède un store Redux à deux branches :

- `logic` : état métier (Shredder immutable) ;
- `ellen` : état interne de persistance Ripley.

### Cycle de vie des acteurs

- **Singleton** : `boot` et/ou `init` (appelées une seule fois), puis quêtes, puis `dispose`.
- **Instanciable** : `create` (constructeur), puis quêtes, puis `delete` (destructeur, optionnel), puis `dispose`.

Détails de la création :

1. La commande `<acteur>.create` est interceptée par `Goblin.#createQuest`. Un identifiant au format `type@uid` est exigé.
2. L'instance est enregistrée dans le registre, puis rattachée à ses parents et à son feed dans le warehouse (`warehouse.attach-to-parents`).
3. La quête `create` est planifiée en mode `immediate` : la file reste en pause jusqu'à la fin de la création. Un `create` concurrent sur le même identifiant (re-create) attend la fin du premier et n'exécute rien de plus.
4. À la fin de la quête, l'état est publié dans le warehouse (`upsert`) et l'événement `finished` est envoyé à tous les appelants en attente.
5. Si la création échoue, la branche warehouse est supprimée et l'instance est libérée.

La destruction est déclenchée par `goblin.delete` lorsque le warehouse publie `warehouse.released` (plus aucun parent). Elle compare la génération de l'instance avec celle du message, attend les quêtes en cours, puis libère l'instance.

La méthode `dispose` n'est pas une quête. Elle ferme les handles de bas niveau (timers, sockets…) lors de la fermeture de l'application. Elle doit rester synchrone et ne pas utiliser le bus.

### Scheduler et modes d'exécution

Le mode d'exécution de chaque quête est déterminé par l'équation `S = BD + AD + AB + AC`, établie par un tableau de Karnaugh :

- A : la quête est `create`.
- B : l'acteur est en cours de création.
- C : l'appelant est lui-même dans un `create`.
- D : l'acteur s'appelle lui-même.

Les modes sont :

- **immediate** : `create` et quêtes appelées depuis un `create`. Elles passent avant tout le reste et débloquent la file.
- **serie** : exécution séquentielle protégée par un mutex.
- **parallel** : exécution concurrente (mode par défaut).

La quête `delete` suit un chemin particulier : elle attend toutes les promesses en cours avant de s'exécuter.

### Gestion d'état

L'état est géré par [xcraft-core-shredder] (wrapper Immutable.js). Pour les Elves, les classes `Spirit` et les traps traduisent les manipulations JavaScript naturelles (`state.foo = 1`, `state.list.push(x)`, `delete state.obj.key`, `for..of`) en opérations immutables.

Les shapes sont définies avec [xcraft-core-stones] :

- `Elf.Sculpt(Shape)` produit la classe d'état typée.
- L'option `GOBLIN_CHECKTYPE` active la validation des états rechargés depuis Cryo.

### Sécurité (Guild Enforcer)

Le Guild Enforcer protège chaque quête enregistrée par un « shield » dont les compétences (skills) sont définies via `Goblin.skills`. À chaque appel, il vérifie deux choses :

- l'acteur appelant est capable (capabilities) ;
- l'utilisateur identifié dans `msg.context._goblinUser` est capable.

Un utilisateur sans identité devient invité (`guest`). Un utilisateur authentifié par JWT reçoit un rang selon les claims définis dans les politiques (`enroleByClaims`, avec `aud` en repli).

Si aucun fichier de politique n'existe, le niveau par défaut vient de `busConfig.defaultPolicyLevel` :

- `0` : tout est autorisé pour `system` et `guest` ;
- `1` : un token JWT est requis pour les non-system.

### Synchronisation distribuée (Ripley)

Ripley permet la synchronisation bidirectionnelle des actions `persist` entre un client et un serveur. Le flux général est le suivant :

```
Client                                  Serveur
  │                                        │
  ├─ ripleyCheckBeforeSync ───────────────►│ (ripleyCheckForCommitId)
  ├─ _ripleyPrepareSync (zero commitId)    │
  ├─ ripleyServer(actions, commitIds) ────►│
  │                                        ├─ crée les acteurs, rejoue $4ellen
  │                                        ├─ calcule la plage de persists manquants
  │◄── persisted + newCommitId + stream ───┤
  ├─ RipleyWriter (lots via computeRipleySteps)
  ├─ _ripleyApplyPersisted (insertOrCreate + persist)
  └─ updateActionsAfterSync (zero → commitId serveur)
```

Points clés :

- Les actions non persistées sont envoyées au serveur taguées avec un `commitId` « zéro » (`00000000-0000-0000-0000-000000000000`). Elles ne sont remplacées par le vrai `commitId` qu'une fois la synchronisation réussie, ce qui évite les doublons après une interruption.
- `computeRipleySteps` découpe les actions en lots d'environ 20 sans jamais séparer deux actions de même `commitId`. Un `commitId` plus gros que la limite reste donc dans un seul lot.
- Si les bases sont trop éloignées (plus de `actionsSync.bootstrapLimit` persists), ou si le `commitId` local est inconnu du serveur, un bootstrap complet est réalisé via `ripleyGetAllPersist` et `cryo.bootstrapActions`.
- Côté serveur (`actionsSync.isServer`), seules les quêtes `ripleyServer`, `ripleyPersistFromZero`, `ripleyGetAllPersist` et `ripleyCheckForCommitId` sont enregistrées. Côté client, seule `ripleyClient` l'est.
- Chaque base ne peut être synchronisée que si elle fait partie de la liste `dbSyncList` (calculée via `getAllRipleyDB`).

### Insertion directe dans Cryo

Les quêtes spéciales `insertOrCreate` et `insertOrReplace` sont interceptées par `Goblin.#insertQuest` :

- Elles utilisent un mutex par identifiant et n'exécutent pas de vraie quête.
- `insertOrCreate` insère l'état dans Cryo seulement si l'acteur n'existe pas déjà (sinon l'appelant doit faire un `create`).
- `insertOrReplace` remplace l'état, y compris d'un acteur déjà instancié (action `persist`, puis upsert dans le warehouse).
- Côté serveur, un `commitId` est généré et la synchronisation est diffusée (`syncBroadcast`). Côté client, la synchronisation est planifiée.

### Écoute réactive de Cryo

Les Elves disposent de `this.cryo.listenTo(actorType, callback)`. Cette API enregistre des triggers sur les dernières actions persistées d'un type d'acteur. Le callback reçoit le topic (`-inserted`, `-updated` ou `-deleted`) et l'identifiant de l'acteur concerné, ou `null` pour l'événement initial. La souscription est nettoyée à la destruction de l'acteur.

## Exemples d'utilisation

### Acteur Elf avec persistance (Archetype)

```javascript
const {Elf} = require('xcraft-core-goblin');
const {string, option, number} = require('xcraft-core-stones');
const {id} = require('xcraft-core-goblin/lib/types.js');

class MyActorShape {
  id = id('myActor');
  label = string;
  data = option(number);
}

class MyActorState extends Elf.Sculpt(MyActorShape) {}

class MyActorLogic extends Elf.Archetype {
  static db = 'myapp';
  static indices = ['id'];
  state = new MyActorState();

  create(id, label, data) {
    const {state} = this;
    state.id = id;
    state.label = label;
    state.data = data;
  }

  updateData(data) {
    const {state} = this;
    state.data = data;
  }
}

class MyActor extends Elf {
  logic = Elf.getLogic(MyActorLogic);
  state = new MyActorState();

  async create(id, desktopId, label, initialData) {
    this.logic.create(id, label, initialData);
    await this.persist();
    return this;
  }

  async updateData(newData) {
    this.logic.updateData(newData);
    await this.persist();
  }

  delete() {}
}

exports.xcraftCommands = Elf.birth(MyActor, MyActorLogic);
```

### Utilisation d'un acteur Elf

```javascript
// Feed temporaire, nettoyé automatiquement à la fin de la quête
const feedId = await this.newQuestFeed();
const actor = await new MyActor(this).create(
  Elf.newId('myActor'),
  feedId,
  'Mon acteur',
  42
);
await actor.updateData(84);

// Lecture de l'état local (copie au moment de l'appel)
console.log(actor.state.data); // 84
```

### Acteur Elf singleton (Alone)

```javascript
class MyService extends Elf.Alone {
  async init(desktopId) {
    // appelée une seule fois
  }

  async doSomething() {
    this.log.info('Hello');
  }
}

exports.xcraftCommands = Elf.birth(MyService);

// Utilisation
const svc = new MyService(this);
await svc.doSomething();
```

### Événements entre acteurs Elf

```javascript
class Producer extends Elf {
  async notify() {
    // Événement `<something-done>` émis pour cet acteur
    this.emit('something-done', {when: Date.now()});
  }
}

class Consumer extends Elf.Alone {
  async init() {
    // Écoute uniquement les événements de l'acteur `producer@main`
    this.on(
      'something-done',
      async (data) => {
        this.log.info(`Reçu ${JSON.stringify(data)}`);
      },
      'producer@main'
    );
  }
}
```

### Écoute réactive d'un type d'acteur

```javascript
class MyWatcher extends Elf.Alone {
  async init() {
    await this.cryo.listenTo('myActor', async (topic, actorId) => {
      this.log.info(`Changement détecté sur ${actorId} (${topic})`);
    });
  }
}
```

### Requête typée sur Cryo

```javascript
const reader = await this.cryo.reader('myapp');
const rows = reader
  .queryArchetype('myActor', MyActorShape)
  .select(['id', 'label'])
  .where((actor) => actor.get('data').gt(10))
  .all();
```

### Test unitaire d'une logique Elf

```javascript
const {Elf} = require('xcraft-core-goblin');

const logic = Elf.trial(MyActorLogic);
logic.create('myActor@test', 'test', 42);
expect(logic.state.data).to.be.equal(42);

logic.updateData(99);
expect(logic.state.data).to.be.equal(99);
```

### Test d'intégration avec le Runner

```javascript
const {Elf} = require('xcraft-core-goblin/lib/test.js');

describe('mon acteur', function () {
  let runner;
  this.beforeAll(() => {
    runner = new Elf.Runner();
    runner.init();
  });
  this.afterAll(() => runner.dispose());

  it('crée un acteur', async function () {
    await runner.it(async function () {
      const feedId = await this.newQuestFeed();
      const actor = await new MyActor(this).create(
        Elf.newId('myActor'),
        feedId,
        'test',
        1
      );
      expect(actor.state.data).to.be.equal(1);
    });
  });
});
```

### Acteur Goblin legacy

```javascript
const Goblin = require('xcraft-core-goblin');

const logicState = {id: null, counter: 0};
const logicHandlers = {
  create: (state, action) => state.set('id', action.get('id')),
  increment: (state) => state.set('counter', state.get('counter') + 1),
};

Goblin.registerQuest('counter', 'create', function* (quest) {
  quest.do();
  return quest.goblin.id;
});

Goblin.registerQuest('counter', 'increment', function* (quest) {
  quest.do();
});

Goblin.registerQuest('counter', 'delete', function (quest) {});

exports.xcraftCommands = () =>
  Goblin.configure('counter', logicState, logicHandlers);
```

Création et appel depuis une autre quête (système quest, car il s'agit d'un acteur Goblin) :

```javascript
const counterId = `counter@${quest.uuidV4()}`;
const counter = yield quest.create('counter', {
  id: counterId,
  desktopId: quest.getDesktop(),
});
yield counter.increment();
```

### File d'attente avec workers

```javascript
// Worker : un acteur instanciable créé/détruit à chaque job
Goblin.buildQueueWorker('my-queue', {
  workQuest: async function (quest, jobData) {
    // Traitement du job
    return {result: 'done'};
  },
});

// File : un singleton qui écoute un événement et distribue les jobs
Goblin.buildQueue('my-queue', {
  sub: 'some-service.<job-available>',
  queueSize: 50,
});
```

### Construction d'une application

```javascript
const Goblin = require('xcraft-core-goblin');

module.exports = Goblin.buildApplication('my-app', {
  icon: '🚀',
  useWorkshop: true,
  quests: {
    boot: function* (quest) {
      // initialisation personnalisée après workshop.init
    },
  },
});
```

## Interactions avec d'autres modules

- **[xcraft-core-bus]** : routage des commandes et des événements, chargement des modules (`xcraftCommands`).
- **[xcraft-core-busclient]** : création des réponses (`resp`) utilisées par les quêtes.
- **[xcraft-core-cryo]** : persistance des actions (`cryo.freeze`, `cryo.thaw`) et synchronisation.
- **[xcraft-core-book]** : classe `SQLite` de base pour les lecteurs, chercheurs et la base des utilisateurs.
- **[xcraft-core-pickaxe]** : constructeur de requêtes typées utilisé par `queryArchetype`.
- **[goblin-warehouse]** : relations parent/enfant, feeds et publication des états (`upsert`, `attach-to-parents`).
- **[xcraft-core-shredder]** : structures de données immutables.
- **[xcraft-core-stones]** : système de types pour les shapes et la validation.
- **[xcraft-core-horde]** : nœuds distribués, détection de la connectivité pour la synchronisation.
- **[xcraft-core-host]** : informations sur l'application (`appId`, `variantId`, tribes, routing key) et gestionnaire de fenêtres.
- **[xcraft-core-etc]** : chargement de la configuration (`xcraft-core-goblin`, `xcraft-core-bus`, `xcraft-core-horde`).
- **[xcraft-core-utils]** : réflexion sur les fonctions, mutex, `JobQueue`, `RankedCache`.
- **[xcraft-core-log]** : journalisation.
- **[goblin-workshop]** : utilisé par `quest.createEntity` et par `appBuilder` (quête `workshop.init`).
- **[goblin-laboratory]** : les desktops et laboratoires (feeds) servent de contexte aux fenêtres, via `winDesktopId`.

## Configuration avancée

Les options suivantes sont définies dans `config.js` et exploitées via [xcraft-core-etc].

| Option                       | Description                                                  | Type      | Valeur par défaut |
| ---------------------------- | ------------------------------------------------------------ | --------- | ----------------- |
| `enableCryo`                 | Active le stockage d'actions via Cryo                        | `boolean` | `false`           |
| `actionsSync.enable`         | Active la synchronisation des actions pour Cryo              | `boolean` | `false`           |
| `actionsSync.isServer`       | Fait agir le nœud comme serveur de synchronisation           | `boolean` | `false`           |
| `actionsSync.excludeDB`      | Bases de données exclues de la synchronisation               | `array`   | `[]`              |
| `actionsSync.bootstrapLimit` | Distance au-delà de laquelle un bootstrap complet est requis | `number`  | `20000`           |
| `enableGuildEnforcerCache`   | Active le cache SQLite des utilisateurs du Guild Enforcer    | `boolean` | `false`           |

L'option de ligne de commande `--disable-actions-sync` désactive la synchronisation même si `actionsSync.enable` vaut `true`. La configuration est alors sauvegardée à jour.

### Variables d'environnement

| Variable                 | Description                                                | Exemple          | Valeur par défaut |
| ------------------------ | ---------------------------------------------------------- | ---------------- | ----------------- |
| `GOBLIN_ENFORCER_LOOSE`  | Ne gèle pas (freeze) l'objet du Guild Enforcer             | `1`              | `undefined`       |
| `NODE_ENV`               | Avec `development`, vérifie les noms réservés des Elves    | `development`    | `undefined`       |
| `GOBLIN_RUNNER_SHUTDOWN` | Avec `no`, le runner de tests n'arrête pas le serveur      | `no`             | `undefined`       |
| `GOBLIN_CHECKTYPE`       | Valide l'état Archetype rechargé depuis Cryo avec le shape | `1`              | `undefined`       |
| `XCRAFT_ROOT`            | Racine de l'environnement ; définie par `lib/test.js`      | `/tmp/app-test`  | `undefined`       |
| `GOBLINS_APP`            | Application ciblée ; définie par `lib/test.js`             | `my-app@default` | `undefined`       |

## Détails des sources

### `goblin.js`, `goblin-cache.js`, `goblin-orc.js`

Points d'entrée exposant les commandes (`xcraftCommands`) respectivement de `lib/service.js`, `lib/cache/cache.js` et `lib/goblin-orc.js`.

### `goblin-registry.js`

Expose la commande `<routingKey>.getState` (parallèle, paramètre requis `goblinId`). Elle retourne l'état d'un goblin local, ou `null` s'il n'existe pas ou n'est pas encore créé. Elle est utilisée par `quest.getState` pour lire l'état d'acteurs situés sur une autre tribe. En cas d'erreur, un événement `.error` est envoyé, puis `.finished` dans tous les cas.

### `lib/index.js`

Classe principale `Goblin` : registre des quêtes, des instances et des sessions, store Redux de chaque acteur, quêtes spéciales `create` et `insertOrCreate`/`insertOrReplace`, intégration Ripley et middleware de sécurité.

Fonctions exportées en plus de la classe :

- `Goblin.skills` : proxy qui retourne un `Symbol` pour chaque compétence demandée (par exemple `Goblin.skills.OPEN_DESKTOP`).
- `Goblin.ShieldedError`, `Goblin.SmartId`, `Goblin.Shredder`, `Goblin.Elf`.

#### État et modèle de données

Chaque instance contient un store Redux à deux branches :

- `logic` : état métier immutable (Shredder), publié dans le warehouse (la clé `private` n'est pas publiée) ;
- `ellen` : état interne du backend de persistance.

Les données volatiles non Redux sont stockées par instance via `setX`, `getX` et `delX`, et la propriété `feed` y est conservée sous `desktopId`.

#### Méthodes publiques

- **`configure(goblinName, logicState, logicHandlers, goblinConfig)`** — Configure un type d'acteur et retourne `{handlers, rc}` pour le bus. Le rôle par défaut est `system`.
- **`registerQuest(goblinName, questName, quest, options)`** — Enregistre une quête. `options.skills` déclare les compétences requises.
- **`registerQuests(goblinName, quests, options, safe)`** — Enregistrement par lot.
- **`registerSafeQuest(goblinName, questName, questFunc, options)`** — Enveloppe la quête avec `sysCreate`/`sysKill`.
- **`create(goblinName, uniqueIdentifier, generation)`** — Crée une instance.
- **`createSingle(goblinName)`** — Crée un singleton (ignoré sur les tribes secondaires, sauf pour `goblin`).
- **`release(goblinName, goblinId)`** — Libère une instance.
- **`getGoblinsRegistry()`** / **`getSessionsRegistry()`** — Registres globaux.
- **`getParams(goblinName, questName)`** — Paramètres d'une quête, ou `false` si elle est inconnue.
- **`getQuests(goblinName)`** / **`getRC(goblinName)`** — Handlers et définitions de commandes.
- **`buildApplication(appId, config)`**, **`buildQueue(queueName, config)`**, **`buildQueueWorker(queueName, config)`** — Constructeurs.
- **`getActorRipleyRules(actorId, actionType)`**, **`getActorRipleyDB(actorId)`**, **`getAllRipleyDB()`**, **`getAllRipleyActors(db)`**, **`getActorClass(actorId)`** — Introspection Ripley/Elf.
- **`getSystemDesktop(desktopId)`**, **`getGoblinName(goblinId)`**, **`extractGoblinName(goblinId)`**, **`nextGen()`** — Utilitaires d'identifiants.
- **`identifyUser(msg)`**, **`setUser(context, userId)`**, **`enroleUser(instance, tokenData)`**, **`deroleUser(instance, tokenData)`**, **`registerUser(userInfos)`** — Gestion des utilisateurs.
- **`buildGuestFootprint(clientServiceId, windowId)`** / **`buildRemoteGuestFootprint(ctx)`** — Empreintes d'invités locaux et distants.
- **`waitForHordesSync(quest)`** — Attend l'initialisation de la synchronisation. Retourne `false` si le bootstrap échoue.
- **`createAction(type, payload, meta, error)`** — Crée une action Flux Standard.
- **`dispose()`** — Libère le Guild Enforcer et tous les acteurs.

### `lib/quest.js`

Contexte d'exécution des quêtes. Il expose les accesseurs `goblin`, `elf`, `user`, `me`, `sys`, `warehouse`, `log`, `uuidV4`, `calledFrom`, ainsi que `msg` et `resp`.

#### Méthodes publiques

- **`create(namespace, args)`** — Crée un acteur et retourne son API.
- **`createFor(goblinName, goblinId, namespace, args)`** — Crée un acteur rattaché à un parent précis. Le `desktopId` est obligatoire.
- **`createNew(namespace, args)`** — Crée avec un identifiant UUID généré.
- **`createView(namespace, args, view)`** — Crée avec une vue filtrée (`with`/`without`).
- **`createPlugin(namespace, args)`** — Crée un plugin `namespace@<id courant>`.
- **`createEntity(id, properties, view)`** — Crée une entité via [goblin-workshop].
- **`createCache(goblinId)`** — Crée le service de cache si nécessaire.
- **`cmd(cmd, args)`** — Envoie une commande sur le bus.
- **`evt(topic, payload)`** — Émet un événement préfixé par l'identifiant de l'acteur. `evt.send` préfixe par le type de l'acteur et `evt.full` n'ajoute aucun préfixe.
- **`sub(topic, handler)`** — S'abonne à un événement. `sub.local` limite à l'hôte local, `sub.wait` et `sub.localWait` attendent un événement, `sub.callAndWait` et `sub.localCallAndWait` exécutent un appel puis attendent l'événement.
- **`do(payload)`** — Déclenche le reducer de même nom que la quête.
- **`doSync(action)`** — Idem, avec publication immédiate dans le warehouse.
- **`dispatch(type, payload, meta, error)`** — Déclenche un reducer précis.
- **`getAPI(id, namespace, withPrivate, autoSysCall)`** — Construit l'API d'un acteur à partir du registre de commandes.
- **`getState(goblinId)`** / **`isAlive(goblinId)`** — État (y compris d'une autre tribe) et présence locale d'un acteur.
- **`kill(ids, parents, feed)`** / **`release(goblinId)`** — Détache des acteurs ou notifie leur libération.
- **`cancel()`**, **`fireAndForget()`**, **`isCanceled(result)`** — Contrôle du résultat de la quête.
- **`go(cmd, cmdArgs, delay)`** — Planifie une commande via l'événement `<goblin-run>`. Retourne une fonction d'annulation si un délai est donné.
- **`defer(action)`** — Ajoute une action exécutée à la fin de la quête.
- **`sysCall`**, **`sysCreate`**, **`sysKill`** — Appels et cycle de vie dans le feed système.
- **`getSystemDesktop()`**, **`getDesktop(canFail)`**, **`getSession()`**, **`getStorage(service, session)`** — Contexte de bureau et de session.
- **`hasAPI(namespace)`** — Présence d'un namespace sur le bus.
- **`newResponse(routing)`**, **`respArgs()`**, **`respArgsLocal()`** — Réponses bus.
- **`fail(title, desc, hint, ex)`** / **`logCommandError(ex, msg)`** — Notification sur le desktop et log pour Overwatch.

### `lib/scheduler.js` et `lib/scheduler-queue.js`

`Scheduler` détermine le mode d'exécution et alimente une `SchedulerQueue`. Cette file contient trois listes (parallel, serie, immediate) et émet des événements `awake`. La liste `immediate` est prioritaire et reprend la file à la fin du `create`. La liste `serie` est protégée par un mutex. Le `Scheduler` possède aussi une file séquentielle `QuestsQueue` qui garantit l'ordre de dispatch.

- **`pause()`** / **`resume()`** — Suspend ou reprend le traitement parallel et serie.
- **`infos`** — Taille des trois listes.

### `lib/service.js`

Singleton `goblin`. Sa quête `_init` s'abonne aux événements `warehouse.released`, `<axon-orc-added>`, `<axon-orc-removed>` et `<goblin-run>`, charge la configuration de synchronisation et affiche la bannière de démarrage.

#### Quêtes publiques

- **`ripleyServer(db, actions, commitIds, userId)`** — (serveur) applique les actions client et retourne les nouveaux persists.
- **`ripleyClient(db)`** — (client) orchestre une synchronisation complète, avec reprise des actions `zero`.
- **`ripleyCheckBeforeSync(db, noThrow)`** — Vérifie la compatibilité avec le serveur.
- **`ripleyCheckForCommitId(db, commitIds)`** — (serveur) vérifie la connaissance d'un commitId et compte les nouveaux persists.
- **`ripleyPersistFromZero(db, goblinIds)`** / **`ripleyGetAllPersist(db)`** — (serveur) reprise après interruption et bootstrap.
- **`_ripleyPrepareSync(db)`**, **`_ripleyApplyPersisted(...)`** — Quêtes internes du client.
- **`tryShutdown(wait)`** — Attend la fin des synchronisations avant l'arrêt.
- **`sysCreate`**, **`sysKill`**, **`sysCall`** — Création/destruction temporaires dans le feed système.
- **`status()`**, **`xcraftMetrics()`**, **`getQuestGraph()`**, **`cache-clear()`** — Diagnostic et maintenance.

### `lib/ripleySync.js`

Utilitaires de synchronisation :

- **`computeRipleySteps(persisted, commitCnt, limit=20)`** — Calcule les lots sans scinder un `commitId`. Retourne `[persisted.length]` pour un ancien serveur.
- **`applyPersisted(quest, db, actions, progress)`** — Applique un lot dans une transaction Cryo, avec rollback en cas d'erreur.
- **`wrapForSyncing(quest, db, horde, handler, progress)`** — Signale l'état « en synchronisation » si l'opération dépasse 1 seconde.
- **`RipleyWriter`** — Stream `Writable` qui reçoit les persists du serveur.
- **`SHUTTING_DOWN_KEY`** — Clé de session signalant l'arrêt en cours.

### `lib/ripley.js` et `lib/ripley/cryo.js`

`Ripley` est un middleware Redux (`persistWith`) qui persiste les actions filtrées par des règles. Il délègue au backend Cryo (`lib/ripley/cryo.js`), qui appelle `cryo.freeze`, mémorise la dernière action persistée et émet `<goblin-commitId-freezed>`. Les actions rejouées via `ripley()` ne sont pas persistées une seconde fois. Les modes supportés sont `all`, `last` et `allbykeys`.

### `lib/guildEnforcer.js`

Système de sécurité. Il construit les utilisateurs membres (`members`), les rangs (`ranks`) et la politique d'enrôlement. Il nettoie les invités inactifs depuis plus de 5 minutes (vérification chaque minute). Il maintient en option un cache SQLite partagé des utilisateurs, nettoyé au démarrage par l'application maître.

- **`shield(cmd, quest, skills)`**, **`isBlocked(goblin, cmd)`**, **`getRankingPredictions(cmd)`**
- **`enforce(object, rank)`**, **`addGuestUser(footprint)`**, **`getUser(userId)`**
- **`enroleUser(tokenData)`**, **`deroleUser(tokenData)`**, **`registerUser(userInfos)`**
- **`dispose()`**

### `lib/capsAndSkills.js`

- **`Capability.create(goblin, name, delegatable, owner)`**, **`delegate(cap, goblin, ttl, delegatable)`**, **`enable(cap)`**, **`disable(cap)`**, **`fulfill(goblin, quest)`**
- **`SkillsSet.define(refToProtect, skills)`** — Définit le contrat requis.

### `lib/shield/db.js`

Base SQLite des utilisateurs (mode WAL). Des triggers appellent les fonctions `shield_insert`, `shield_update` et `shield_delete` pour répercuter les changements sur le registre en mémoire. Elle expose `get`, `save`, `delete` et `deleteAll`.

### `lib/appBuilder.js`

Construit une application complète. La quête `boot` générée charge la configuration du profil via [xcraft-core-etc] et appelle `workshop.init` si `useWorkshop` est actif. Elle exécute ensuite la quête `boot` personnalisée (`config.quests.boot`). Elle enregistre aussi `getMandate`, `configureDesktop` et `configureNewDesktopSession`.

Options : `quests`, `logicHandlers`, `icon` (`👺`), `useWorkshop` (`true`), `desktop`, `themeContext`, `defaultTheme`, `defaultContextId`.

### `lib/queueBuilder.js` et `lib/workerBuilder.js`

- **`queueBuilder(queueName, config)`** — Singleton qui écoute `config.sub` et alimente une `JobQueue`. Options : `sub` (obligatoire), `queueSize` (100), `queueOptions`, `jobIdGetter`. Sa quête `start-worker` crée un worker temporaire, appelle `work`, puis le détruit et émet `<jobId>.done`.
- **`workerBuilder(queueName, config)`** — Acteur `<queue>-worker` en mode `background`, dont la quête `work` est `config.workQuest` (obligatoire).

### `lib/smartId.js`

Identifiants au format `type@uid`.

- **`SmartId.encode(externalId)`** / **`decode(id)`** — Encodage sûr (caractères `-_.!~*'()` inclus).
- **`SmartId.from(type, externalId, encode=true)`**, **`toExternalId(id)`**, **`getUid(id)`**
- **`isValid()`**, **`isMalformed()`**, **`hasUid()`**

### `lib/types.js`

Types et shapes spécialisés.

- **`id(name)`** / **`IdType`** — Type d'identifiant `` `name@${string}` `` avec validation du préfixe.
- **`MetaShape`** — `index`, `locale`, `scope` (optionnels), `vectors` (enregistrement de `ChunkShape`) et `status` (`published`, `trashed` ou `archived`).
- **`ChunkShape`** — `chunk` et `embedding` (littéral SQLite de blob).

### `lib/osInfo.js`

Fournit `guestHost` et `guestUser` (minuscules, `@` remplacé par `-`) pour les empreintes d'invités.

### `lib/questTracer.js`

Traceur de graphe d'appels (Cytoscape), désactivé par défaut. Il exclut `warehouse`, `goblin` et `workshop`.

### `lib/test.js`

Prépare l'environnement de test (`XCRAFT_ROOT`, `GOBLINS_APP`, `initEtc`) et exporte le module principal.

### `lib/cache/index.js` et `lib/cache/cache.js`

Cache d'instances. `CacheLib.update(goblinId, TTL)` gère le TTL (un délai de 0 supprime l'entrée). `CacheLib.rank(goblinName, goblinId, size)` rattache l'acteur au cache et évince les moins utilisés d'un `RankedCache` par type. L'acteur `goblin-cache` stocke un état privé (`private.goblins`, `private.cache`, `private.items`) non publié, expose les métriques `ranked` et `ttl`, et réagit à l'événement `goblin-cache.clear`.

### `lib/cryo/manager.js`

Gestionnaire central, avec un lecteur et un chercheur par base. Il tente d'abord le handle de `xcraft-core-cryo`, puis une connexion en lecture seule.

- **`reader`**, **`fullTextSearcher`**
- **`search`**, **`search2`**, **`searchDistance`**, **`searchDistance2`**, **`getDistinctScopes`**, **`searchRaw`**
- **`getState`**, **`getIds`**, **`pickAction`**
- **`isPersisted`**, **`isPublished`**, **`commitStatus`** (`'none'`, `'staged'` ou `'commited'`)
- **`syncBroadcast(db)`** — Événement `cryo-db-synced`, debounced à 500 ms, ignoré pour les bases exclues.

### `lib/cryo/reader.js`

`CryoReader` (étend `SQLite`) :

- **`getGoblinState`**, **`getGoblinIds`**, **`pickAction`**, **`isPersisted`**, **`isPublished`**, **`commitStatus`**
- **`queryArchetype(goblinType, shape, noAttach=false)`** — Requête typée [xcraft-core-pickaxe], avec attachement automatique des autres bases.
- **`queryWorkerStream(query)`** — Exécute la requête dans un worker Piscina et retourne un stream de lignes.
- **`queryEmbeddings(vectors)`**, **`attachReader`**, **`attachDB`**, **`iterateQuery`**, **`normalizeFileName`**

### `lib/cryo/search.js`

`CryoSearch` : recherche FTS5 (`search`, `search2` avec scoring normalisé) et vectorielle via `sqlite-vector` (`searchDistance`, `searchDistance2`). Il expose aussi `getDistinctScopes` et `searchRaw`. Chaque fonction n'est activée que si la configuration de [xcraft-core-cryo] (`enableFTS`, `enableVEC`) le permet pour la base.

### `lib/cryo/shapes.js`

- **`LastPersistedActionShape(shape)`** — Action `persist` avec état typé.
- **`EmbeddingsShape`** — `scope`, `locale`, `documentId`, `chunkId`, `chunk`, `distance`, `embedding`.

### `lib/cryo/workers/sql.js`

Worker Piscina (`exec`) : ouvre une connexion en lecture seule, attache les bases nécessaires et transmet les lignes par `MessagePort`.

### `lib/sync/index.js` et `lib/sync/hordesSync.js`

`Sync.sync(db)` regroupe les demandes avec un debounce de 500 ms et relance en cas d'échec. `HordesSync` gère :

- **`boot()`** — Bootstrap des bases vides ou incompatibles (avec renommage si le dernier `commitId` est inconnu du serveur), puis émission de `goblin.hordesSync-initialized`.
- **`sync(db)`** — Synchronisation incrémentale via `goblin.ripleyClient`. Elle est ignorée si la socket est perdue, si un lag est en cours, si la base est exclue ou si le boot n'est pas terminé.

Il surveille les événements `<perf>` : un lag de 30 secondes ou plus annule les commandes en cours, et la reconnexion déclenche une resynchronisation complète. Pendant le bootstrap, le délai de lag maximal passe à 4 minutes.

### `lib/elf/index.js`

Implémente `Elf`, `Elf.Alone` (singleton, quête `init`), `Elf.Spirit`, `Elf.Archetype` et les utilitaires statiques.

L'activation d'un `Archetype` enregistre automatiquement :

- la quête `persist` ;
- les quêtes internes `insertOrCreate` et `insertOrReplace` ;
- la quête `$4ellen`, utilisée par le serveur Ripley pour rejouer les actions client.

Les propriétés statiques de la classe de logique sont :

- `db` (obligatoire) : nom de la base Cryo ;
- `indices` : colonnes indexées pour `queryArchetype` ;
- `noHistory` : conserve uniquement la dernière action `persist`.

Le hook optionnel `beforePersistOnServer()` permet de modifier l'état juste avant le persist final côté serveur.

Options du constructeur (`ElfOptions`) :

- `session` : `{desktopId, parent}` ;
- `ripley` ;
- `create` : `{ttl}`, pour passer par `goblin-cache` ;
- `bus` : `{rpc}`.

Les noms réservés (`Me.reserved`) ne peuvent pas être utilisés comme méthodes ou propriétés, ce qui est vérifié avec `NODE_ENV=development`.

#### Méthodes statiques

- **`Elf.birth(elfClass, logicClass)`** — Enregistre la classe et retourne la fonction pour `xcraftCommands`.
- **`Elf.configure(elfClass, logicClass)`** — Configure les quêtes, reducers et règles Ripley.
- **`Elf.trial(logicClass)`** — Instance de logique pour les tests unitaires.
- **`Elf.Sculpt(type)`** — Classe d'état typée.
- **`Elf.getLogic(logicClass)`**, **`Elf.getClass(type)`**, **`Elf.quests(elfClass)`**, **`Elf.goblinName(cls)`**
- **`Elf.newId(type)`**, **`Elf.uuid()`**, **`Elf.id(id)`**
- **`Elf.createFeed(prefix)`** — _(Déprécié)_ préférer `this.newQuestFeed()`.
- **`Elf.Archetype.exist(cryo, actorId)`** — Existence dans Cryo, y compris pour un acteur `trashed`.

#### Méthodes d'instance

- **`this.newQuestFeed(prefix)`** — Feed temporaire nettoyé à la fin de la quête (interdit dans `create`).
- **`this.killFeed(feedId, xcraftRPC)`**, **`this.kill(ids, parents, feed, xcraftRPC)`**
- **`this.persist()`**, **`this.insertOrCreate(id, desktopId, state, commitId)`**, **`this.insertOrReplace(id, desktopId, state)`**
- **`this.api(id)`** — API d'un acteur existant, avec lecture de l'état local.
- **`this.on(eventName, listener, fromActorId)`** — S'abonne à un événement (nettoyé à la destruction).
- **`this.emit(eventName, data, actorId)`** — Émet un événement.
- **`this.winDesktopId()`**, **`this.desktop.id()`**, **`this.desktop.emit(topic, data)`**
- **`this.cryo.*`** — Accès au `CryoManager` (`getState`, `getIds`, `search*`, `reader`, `pickAction`, `isPersisted`, `isPublished`, `sync`, `listenTo`).
- **`this.log`**, **`this.quest`**, **`this.user`**

### `lib/elf/me.js`

Wrapper `Me` : fusionne `quest.me` et l'instance Elf. Il expose l'état du goblin courant via `state`, les reducers via `logic`, et les services ci-dessus (`cryo`, `desktop`, `on`, `emit`, `persist`, etc.). `Me.createFeed(prefix)` produit `system@[prefix@]uuid`.

### `lib/elf/spirit.js`, `lib/elf/list.js` et `lib/elf/traps.js`

- **`Spirit.from(sculptedClass)`** — Proxy d'état à partir d'un Shredder.
- **`List`** — Wrapper de tableau immutable (`push`, `map`, `deleteByValue`, `indexOf`, `includes`, `length`, itération).
- **`logicTraps`** — Appels `this.logic.xxx()` : seuls les arguments qui diffèrent du message courant sont transmis dans le payload.
- **`stateTraps`** / **`mapTraps`** — Lecture, écriture, suppression et énumération de l'état.
- **`directTraps`** — Côté serveur : appelle l'implémentation réelle avec un `Me`.
- **`forwardTraps`** — Côté client : transforme les appels en commandes bus et mappe les arguments positionnels en objet. Gère `create`, `insertOrCreate`, `insertOrReplace`, `api`, ainsi que les options `ttl` et `session`.
- **`meTraps`** — API de l'acteur courant (`quest.me`).

### `lib/elf/runner.js`

Runner de tests : lance un serveur Xcraft via [xcraft-core-host].

- **`init()`** — Idempotent. Nettoie le répertoire de configuration s'il se termine par `-test`.
- **`it(callback)`** — Exécute le test avec un `Me` en `this`.
- **`dispose()`** — Arrêt du serveur, sauf si `GOBLIN_RUNNER_SHUTDOWN=no`.

### `lib/elf/utils.js`, `lib/elf/params.js` et `lib/elf/cacheParams.js`

- **`getProperties(obj)`**, **`getAllFuncs(obj, depth=2)`**, **`checkId(id, goblinName)`**
- **`cacheQuestParams`** et **`cacheReduceParams`** : instances de `CacheParams` (`register`, `get`, `know`) évitant la réflexion répétée sur les signatures.

### `lib/goblin-orc.js`

Acteur Goblin représentant une connexion bus (orc). Il est créé et supprimé par le service principal lors des événements `<axon-orc-added>` et `<axon-orc-removed>`.

#### État et modèle de données

- `id` : identifiant de l'orc ;
- `data` : métadonnées clé-valeur.

#### Quêtes publiques

- **`create()`**, **`setData(key, data)`**, **`delete()`**

## Licence

Ce module est distribué sous [licence MIT](./LICENSE).

---

_Ce contenu a été généré par IA_

[xcraft-core-bus]: https://github.com/Xcraft-Inc/xcraft-core-bus
[xcraft-core-busclient]: https://github.com/Xcraft-Inc/xcraft-core-busclient
[xcraft-core-cryo]: https://github.com/Xcraft-Inc/xcraft-core-cryo
[xcraft-core-book]: https://github.com/Xcraft-Inc/xcraft-core-book
[xcraft-core-pickaxe]: https://github.com/Xcraft-Inc/xcraft-core-pickaxe
[xcraft-core-shredder]: https://github.com/Xcraft-Inc/xcraft-core-shredder
[xcraft-core-stones]: https://github.com/Xcraft-Inc/xcraft-core-stones
[xcraft-core-horde]: https://github.com/Xcraft-Inc/xcraft-core-horde
[xcraft-core-host]: https://github.com/Xcraft-Inc/xcraft-core-host
[xcraft-core-etc]: https://github.com/Xcraft-Inc/xcraft-core-etc
[xcraft-core-utils]: https://github.com/Xcraft-Inc/xcraft-core-utils
[xcraft-core-log]: https://github.com/Xcraft-Inc/xcraft-core-log
[goblin-warehouse]: https://github.com/Xcraft-Inc/goblin-warehouse
[goblin-workshop]: https://github.com/Xcraft-Inc/goblin-workshop
[goblin-laboratory]: https://github.com/Xcraft-Inc/goblin-laboratory
