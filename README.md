# 📘 xcraft-core-goblin

> Goblins are small, green (or yellow-green) creatures with pointy features and high intelligence (though often little common sense). Goblins speak Goblin, Orcish, and Common. Goblins know myriad languages in order to trade with as many races as possible.

## Aperçu

Le module `xcraft-core-goblin` est le cœur du framework Xcraft, fournissant une API pour créer des microservices basés sur Redux appelés "Goblins". Il implémente un système d'acteurs avec gestion d'état immutable, persistance via Cryo, et communication par bus de messages. Le module offre deux types d'acteurs principaux : les acteurs Goblin (legacy) et les acteurs Elf (moderne), avec support pour la sécurité via le Guild Enforcer et la synchronisation distribuée.

Une documentation présentant les acteurs Elf pas à pas est disponible sur le site Xcraft : https://xcraft.ch/elves/

## Sommaire

- [Structure du module](#structure-du-module)
- [Fonctionnement global](#fonctionnement-global)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Interactions avec d'autres modules](#interactions-avec-dautres-modules)
- [Configuration avancée](#configuration-avancée)
- [Détails des sources](#détails-des-sources)

## Structure du module

Le module s'organise autour de plusieurs composants principaux :

- **Goblin** : Classe principale pour les acteurs legacy avec système Redux
- **Elf** : Nouvelle génération d'acteurs avec API moderne et proxies
- **Quest** : Contexte d'exécution pour les méthodes d'acteurs
- **Scheduler** : Gestionnaire de files d'attente pour l'exécution des quêtes
- **GuildEnforcer** : Système de sécurité et contrôle d'accès
- **Ripley** : Système de persistance et synchronisation d'état
- **Cache** : Gestion du cache avec TTL et ranking
- **CryoManager** : Gestionnaire centralisé pour les opérations de lecture et recherche dans Cryo

## Fonctionnement global

### Architecture des acteurs

Le framework propose deux modèles d'acteurs :

1. **Acteurs Goblin (legacy)** : Utilisent des générateurs et le pattern Redux classique
2. **Acteurs Elf** : API moderne avec classes, proxies et gestion automatique de l'état

### Cycle de vie des acteurs

- **Singleton** : `boot`/`init` → quêtes → `dispose`
- **Instanciable** : `create` → quêtes → `delete` → `dispose`

### Gestion d'état

L'état des acteurs est géré via Shredder (wrapper Immutable.js) avec mutations atomiques via reducers, persistance automatique via Ripley/Cryo, et synchronisation temps réel entre clients/serveurs.

### Scheduler et modes d'exécution

Le `Scheduler` gère trois modes d'exécution des quêtes, déterminés automatiquement selon un tableau de Karnaugh basé sur l'état de création de l'acteur :

- **immediate** : Pour les quêtes `create` et celles invoquées depuis un `create` ; bloque la file jusqu'à la fin de la création
- **serie** : Exécution séquentielle avec verrou mutex
- **parallel** : Exécution concurrente sans blocage

### Sécurité

Le Guild Enforcer contrôle l'accès aux quêtes via un système de capacités (capabilities), de rôles et compétences (skills), d'authentification JWT, et de politiques de sécurité configurables.

### Synchronisation distribuée (Ripley)

Le système Ripley permet la synchronisation bidirectionnelle des états entre serveurs et clients. Le flux général est le suivant :

```
Client                          Serveur
  │                                │
  ├─ _ripleyPrepareSync(db) ──────►│
  ├─ ripleyServer(actions, ...) ──►│
  │◄──────────── persisted + stream┤
  ├─ _ripleyApplyPersisted ────────┤
  └─ updateActionsAfterSync ───────┘
```

La classe `RipleyWriter` (un stream Node.js `Writable`) gère la réception progressive des actions du serveur en lots (`computeRipleySteps`) pour éviter les transactions trop volumineuses tout en préservant l'intégrité des `commitId`.

## Exemples d'utilisation

### Acteur Elf avec persistance (Archetype)

```javascript
const {Elf} = require('xcraft-core-goblin');
const {string, option, number} = require('xcraft-core-stones');
const {id} = require('xcraft-core-goblin/lib/types.js');

class MyActorShape {
  id = id('myActor');
  data = option(number);
}

class MyActorState extends Elf.Sculpt(MyActorShape) {}

class MyActorLogic extends Elf.Archetype {
  static db = 'myapp';
  state = new MyActorState();

  create(actorId, data) {
    const {state} = this;
    state.id = actorId;
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

  async create(id, desktopId, initialData) {
    this.logic.create(id, initialData);
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
// Création avec feed temporaire auto-nettoyé
const feedId = await this.newQuestFeed();
const actor = await new MyActor(this).create('myActor@123', feedId, 42);
await actor.updateData(84);

// Lecture de l'état local
const value = actor.state.data; // 84
```

### Test unitaire d'une logique Elf

```javascript
const {Elf} = require('xcraft-core-goblin');

const logic = Elf.trial(MyActorLogic);
logic.create('myActor@test', 42);
expect(logic.state.data).to.be.equal(42);

logic.updateData(99);
expect(logic.state.data).to.be.equal(99);
```

### Acteur Elf singleton (Alone)

```javascript
class MyService extends Elf.Alone {
  async init(desktopId) {
    // Quête d'initialisation (appelée une seule fois)
  }

  async doSomething() {
    // Logique métier
  }
}

// Utilisation
const svc = new MyService(this);
await svc.doSomething();
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

exports.xcraftCommands = () =>
  Goblin.configure('counter', logicState, logicHandlers);
```

### File d'attente avec workers

```javascript
// Définir un worker
const workerService = Goblin.buildQueueWorker('my-queue', {
  workQuest: async function (quest, jobData) {
    // Traitement du job
    return {result: 'done'};
  },
});

// Définir la file
const queueService = Goblin.buildQueue('my-queue', {
  sub: 'some-service.<job-available>',
  queueSize: 50,
});
```

## Interactions avec d'autres modules

- **[xcraft-core-bus]** : Communication inter-acteurs et routage des messages
- **[xcraft-core-cryo]** : Persistance et synchronisation des états
- **[goblin-warehouse]** : Gestion des relations parent-enfant et feeds
- **[xcraft-core-shredder]** : Structures de données immutables
- **[xcraft-core-stones]** : Système de types pour la validation des états
- **[xcraft-core-horde]** : Gestion des nœuds distribués pour la synchronisation
- **[goblin-laboratory]** : Composants UI React pour les widgets

## Configuration avancée

| Option                       | Description                                                     | Type      | Valeur par défaut |
| ---------------------------- | --------------------------------------------------------------- | --------- | ----------------- |
| `enableCryo`                 | Active le stockage d'actions via Cryo                           | `boolean` | `false`           |
| `actionsSync.enable`         | Active la synchronisation des actions pour Cryo                 | `boolean` | `false`           |
| `actionsSync.excludeDB`      | Liste des bases de données exclues de la sync                   | `array`   | `[]`              |
| `actionsSync.bootstrapLimit` | Nombre d'actions au-delà duquel un bootstrap complet est requis | `number`  | `20000`           |
| `enableGuildEnforcerCache`   | Active le cache SQLite du guild enforcer                        | `boolean` | `false`           |

### Variables d'environnement

| Variable                 | Description                                            | Exemple       | Valeur par défaut |
| ------------------------ | ------------------------------------------------------ | ------------- | ----------------- |
| `GOBLIN_ENFORCER_LOOSE`  | Désactive le verrouillage (freeze) du guild enforcer   | `true`        | `undefined`       |
| `NODE_ENV`               | Mode de développement pour validations supplémentaires | `development` | `undefined`       |
| `GOBLIN_RUNNER_SHUTDOWN` | Contrôle l'arrêt automatique du runner de tests        | `no`          | `undefined`       |
| `GOBLIN_CHECKTYPE`       | Active la validation de types des états Archetype      | `1`           | `undefined`       |

## Détails des sources

### `goblin-cache.js`

Point d'entrée pour les commandes du service de cache. Expose les commandes définies dans `lib/cache/cache.js`.

### `goblin-orc.js`

Point d'entrée pour les commandes du service goblin-orc. Expose les commandes définies dans `lib/goblin-orc.js`.

### `goblin-registry.js`

Service de registre pour accéder à l'état des goblins. Fournit la commande `getState` (avec routing key dynamique selon le nœud) pour récupérer l'état d'un goblin par son ID, avec gestion des erreurs et support multi-tribe via `xcraft-core-host`.

### `goblin.js`

Point d'entrée principal pour les commandes du service goblin. Expose les commandes définies dans `lib/service.js`.

### `lib/index.js`

Classe principale `Goblin` qui implémente le système d'acteurs legacy. Gère la création d'instances, l'exécution des quêtes via Redux, la persistance Ripley, et l'intégration avec le scheduler. Fournit l'API de base pour `quest.create`, `quest.cmd`, et la gestion du cycle de vie des acteurs.

#### État et modèle de données

L'état des Goblins est géré via Shredder avec une structure Redux à deux branches :

- `logic` : État métier de l'acteur (Shredder immutable)
- `ellen` : État de persistance Ripley

#### Méthodes publiques

- **`configure(goblinName, logicState, logicHandlers, goblinConfig)`** — Configure un nouveau type d'acteur Goblin avec son état initial et ses reducers Redux.
- **`registerQuest(goblinName, questName, quest, options)`** — Enregistre une quête (méthode) pour un type d'acteur donné.
- **`registerQuests(goblinName, quests, options, safe)`** — Enregistrement par lot de plusieurs quêtes.
- **`registerSafeQuest(goblinName, questName, questFunc, options)`** — Enregistrement avec création/suppression automatique d'instance système.
- **`create(goblinName, uniqueIdentifier, generation)`** — Crée une nouvelle instance d'acteur.
- **`createSingle(goblinName)`** — Crée un acteur singleton (non disponible sur les tribes secondaires).
- **`release(goblinName, goblinId)`** — Libère une instance d'acteur et nettoie ses ressources.
- **`getGoblinsRegistry()`** — Retourne le registre global de tous les acteurs instanciés.
- **`getSessionsRegistry()`** — Retourne le registre des sessions (stockage local par acteur).
- **`buildApplication(appId, config)`** — Construit une application Xcraft complète.
- **`buildQueue(queueName, config)`** — Construit un système de file d'attente.
- **`buildQueueWorker(queueName, config)`** — Construit un worker pour une file d'attente.
- **`identifyUser(msg)`** — Identifie un utilisateur à partir d'un message du bus.
- **`setUser(context, userId)`** — Définit l'utilisateur courant dans un contexte de quête.
- **`enroleUser(instance, tokenData)`** — Enregistre un utilisateur à partir d'un token JWT.
- **`deroleUser(instance, tokenData)`** — Supprime un utilisateur du système.
- **`registerUser(userInfos)`** — Enregistre manuellement un utilisateur.
- **`buildGuestFootprint(clientServiceId, windowId)`** — Construit une empreinte pour un utilisateur invité local.
- **`buildRemoteGuestFootprint(ctx)`** — Construit une empreinte pour un utilisateur invité distant (via IP, socketId et zeppelinSessionId).
- **`waitForHordesSync(quest)`** — Attend la synchronisation des hordes avant de continuer.
- **`getActorRipleyRules(actorId, actionType)`** — Retourne les règles Ripley d'un acteur pour un type d'action.
- **`getActorRipleyDB(actorId)`** — Retourne la base de données Cryo associée à un acteur.
- **`getAllRipleyDB()`** — Retourne toutes les bases de données Cryo enregistrées (hors exclusions de `actionsSync.excludeDB`).
- **`getAllRipleyActors(db)`** — Retourne tous les types d'acteurs persistés dans une base, optionnellement filtré par `db`.
- **`getActorClass(actorId)`** — Retourne la classe Elf associée à un type d'acteur.
- **`dispose()`** — Nettoie toutes les ressources du système.
- **`createAction(type, payload, meta, error)`** — Crée une action Redux standard (Flux Standard Action).

### `lib/quest.js`

Contexte d'exécution pour les quêtes d'acteurs. Fournit l'API complète pour interagir avec d'autres acteurs, gérer les événements, accéder aux services système, et manipuler l'état. Centralise toutes les opérations disponibles dans une quête.

#### Méthodes publiques

- **`create(namespace, args)`** — Crée un nouvel acteur et retourne son API.
- **`createFor(goblinName, goblinId, namespace, args)`** — Crée un acteur avec un propriétaire spécifique.
- **`createNew(namespace, args)`** — Crée un acteur avec un ID UUID généré automatiquement.
- **`createView(namespace, args, view)`** — Crée un acteur avec une vue filtrée (propriétés `with`/`without`).
- **`createPlugin(namespace, args)`** — Crée un acteur plugin lié à l'acteur courant (`namespace@goblinId`).
- **`createEntity(id, properties, view)`** — Crée une entité via goblin-workshop.
- **`createCache(goblinId)`** — Crée ou récupère un service de cache.
- **`cmd(cmd, args)`** — Envoie une commande sur le bus Xcraft.
- **`evt(topic, payload)`** — Émet un événement préfixé par l'ID de l'acteur.
- **`sub(topic, handler)`** — S'abonne à un événement et retourne la fonction de désabonnement.
- **`do(payload)`** — Déclenche le reducer correspondant à la quête courante.
- **`doSync(action)`** — Déclenche un reducer et synchronise immédiatement l'état dans le warehouse.
- **`dispatch(type, payload, meta, error)`** — Déclenche un reducer spécifique.
- **`getAPI(id, namespace, withPrivate, autoSysCall)`** — Retourne l'API d'un acteur.
- **`getState(goblinId)`** — Récupère l'état d'un acteur, y compris sur d'autres tribes.
- **`isAlive(goblinId)`** — Vérifie si un acteur est vivant et créé localement.
- **`kill(ids, parents, feed)`** — Détache et supprime des acteurs du warehouse.
- **`release(goblinId)`** — Libère un acteur via le système d'événements.
- **`cancel()`** — Annule l'exécution de la quête courante.
- **`fireAndForget()`** — Marque la quête comme fire-and-forget (pas d'attente de réponse).
- **`isCanceled(result)`** — Vérifie si un résultat indique une annulation.
- **`go(cmd, cmdArgs, delay)`** — Exécute une commande de manière asynchrone via événement (avec délai optionnel).
- **`defer(action)`** — Ajoute une action à exécuter à la fin de la quête.
- **`fail(title, desc, hint, ex)`** — Signale un échec avec notification desktop.
- **`logCommandError(ex, msg)`** — Log une erreur de commande pour overwatch.
- **`sysCall(questName, questArguments)`** — Appelle une quête système sur l'acteur courant.
- **`sysCreate()`** — Crée l'acteur courant dans le feed système.
- **`sysKill()`** — Supprime l'acteur courant du feed système.
- **`getSystemDesktop()`** — Retourne le desktop système correspondant au desktop courant.
- **`getDesktop(canFail)`** — Récupère l'ID du desktop courant.
- **`getSession()`** — Récupère l'ID de session à partir du desktop.
- **`getStorage(service, session)`** — Retourne l'API d'un service de stockage.
- **`hasAPI(namespace)`** — Vérifie si un namespace d'API est disponible sur le bus.
- **`newResponse(routing)`** — Crée une nouvelle réponse bus avec routage spécifique.

### `lib/scheduler.js`

Gestionnaire de files d'attente pour l'exécution des quêtes. Implémente trois modes d'exécution (parallèle, série, immédiat) avec gestion des priorités et prévention des deadlocks lors des opérations de création/suppression d'acteurs.

La logique de routage est basée sur un tableau de Karnaugh à 4 variables (présence dans une `create`, état `isCreating`, appel depuis `create`, appel sur soi-même) : `S = BD + AD + AB + AC`.

#### Méthodes publiques

- **`dispatch(type, payload)`** — Ajoute une quête à la file d'attente appropriée selon son mode.

### `lib/guildEnforcer.js`

Système de sécurité pour contrôler l'accès aux quêtes. Implémente un modèle de capacités avec rôles, compétences, et authentification JWT. Gère les utilisateurs invités et les politiques de sécurité configurables avec cache SQLite optionnel (activé via `enableGuildEnforcerCache`).

Les utilisateurs invités inactifs depuis plus de 5 minutes sont supprimés automatiquement toutes les minutes. Si la variable d'environnement `GOBLIN_ENFORCER_LOOSE` est définie, l'enforcer n'est pas gelé et peut être modifié après initialisation.

Le niveau de politique par défaut est contrôlé par `busConfig.defaultPolicyLevel` : niveau 0 permet tout (system + guest), niveau 1 requiert un token JWT pour les actions non-system.

#### Méthodes publiques

- **`shield(cmd, quest, skills)`** — Protège une quête avec des compétences requises.
- **`enforce(object, rank)`** — Assigne un rang et des capacités à un objet.
- **`enroleUser(tokenData)`** — Enregistre un utilisateur à partir d'un token JWT (utilise les claims `aud` et autres).
- **`deroleUser(tokenData)`** — Supprime un utilisateur du système.
- **`registerUser(userInfos)`** — Enregistre manuellement un utilisateur.
- **`getUser(userId)`** — Récupère un utilisateur par son ID (avec fallback sur le cache SQLite).
- **`isBlocked(goblin, cmd)`** — Vérifie si un acteur est bloqué pour une commande.
- **`addGuestUser(footprint)`** — Ajoute un utilisateur invité avec son empreinte.
- **`getRankingPredictions(cmd)`** — Retourne les prédictions de ranking par rôle pour une commande.
- **`dispose()`** — Nettoie les ressources (intervalle de nettoyage, base SQLite).

### `lib/ripley.js`

Système de persistance pour les acteurs. Gère la sérialisation/désérialisation des états via différents backends (Cryo) avec support pour la réplication et la synchronisation temps réel. Fournit un middleware Redux (`persistWith`) pour l'interception automatique des actions.

#### Méthodes publiques

- **`ripley(store, db, logger)`** — Rejoue les actions persistées dans le store Redux.
- **`persistWith(filters)`** — Middleware Redux pour la persistance automatique selon les filtres.
- **`hasMode(mode)`** — Vérifie si un mode de persistance est supporté (`all`, `last`, `allbykeys`).

### `lib/ripleySync.js`

Utilitaires pour la synchronisation Ripley entre client et serveur. Contient la classe `RipleyWriter` (stream `Writable`) pour la réception progressive des actions, et l'algorithme `computeRipleySteps` pour calculer les lots de synchronisation sans scinder les `commitId`.

#### Fonctions publiques

- **`computeRipleySteps(persisted, commitCnt, limit=20)`** — Calcule les étapes de synchronisation en préservant l'intégrité des commitId. Retourne `[persisted.length]` si `commitCnt` est absent (ancien serveur). Garantit que toutes les actions d'un même `commitId` restent dans le même step.
- **`applyPersisted(quest, db, actions, progress)`** — Applique un lot d'actions persistées dans une transaction Cryo.
- **`wrapForSyncing(quest, db, horde, handler, progress)`** — Enveloppe une opération de sync avec reporting de progression (après 1 seconde de délai).

### `lib/service.js`

Service principal singleton (`goblin`) qui gère l'initialisation du système, la synchronisation Ripley, les métriques, et les quêtes système. S'initialise via la quête `_init` en s'abonnant aux événements de cycle de vie du bus (ajout/suppression d'orcs, libération de branches warehouse, exécution fire-and-forget).

L'option `--disable-actions-sync` sur la ligne de commande permet de désactiver la synchronisation même si elle est configurée à `true`.

#### Quêtes publiques

- **`ripleyServer(db, actions, commitIds, userId)`** — Traite les actions de synchronisation côté serveur : applique les actions client (`$4ellen`), récupère les actions manquantes depuis Cryo, et retourne un stream de persistence.
- **`ripleyClient(db)`** — Orchestre la synchronisation complète côté client avec gestion des `zeroRows` (actions interrompues).
- **`ripleyCheckBeforeSync(db, noThrow)`** — Vérifie la compatibilité locale/serveur avant synchronisation.
- **`ripleyCheckForCommitId(db, commitIds)`** — Vérifie si des commitIds existent sur le serveur et compte les nouvelles persistances. Itère sur plusieurs commitIds (fallback sur le deuxième si le premier est inconnu).
- **`ripleyPersistFromZero(db, goblinIds)`** — Vérifie si des actions avec commitId zéro sont déjà persistées côté serveur.
- **`_ripleyPrepareSync(db)`** — Prépare les données pour la synchronisation (tague les nouvelles actions avec commitId zéro).
- **`_ripleyApplyPersisted(db, persisted, newCommitId, rows)`** — Applique les actions persistées reçues du serveur via `insertOrCreate`.
- **`status()`** — Affiche l'état de tous les acteurs instanciés dans les logs.
- **`xcraftMetrics()`** — Collecte les métriques système (instances, queues, running quests, localStorage).
- **`tryShutdown(wait)`** — Attend la fin des synchronisations en cours avant l'arrêt.
- **`sysCreate(desktopId, goblinId)`** — Crée un acteur dans le feed système.
- **`sysKill(desktopId, goblinId)`** — Supprime un acteur du feed système.
- **`sysCall(desktopId, goblinId, namespace, questName, questArguments)`** — Crée temporairement un acteur, appelle une quête, puis le supprime.
- **`cache-clear()`** — Vide le cache global du système.
- **`getQuestGraph()`** — Retourne le graphe des appels entre quêtes (depuis questTracer).

### `lib/appBuilder.js`

Constructeur d'applications Xcraft. Simplifie la création d'applications complètes avec configuration par défaut, intégration workshop, et gestion des thèmes. La quête `boot` générée charge la configuration depuis `xcraft-core-etc` et initialise workshop si activé. Un hook de démarrage personnalisé peut être fourni via `config.quests.boot`.

#### Options de configuration

- **`quests`** : Quêtes personnalisées à enregistrer (dont `boot` optionnel)
- **`logicHandlers`** : Reducers Redux additionnels
- **`icon`** : Emoji pour les logs (défaut `👺`)
- **`useWorkshop`** : Active l'intégration workshop (défaut `true`)
- **`desktop`**, **`themeContext`**, **`defaultTheme`**, **`defaultContextId`** : Configuration UI

### `lib/workerBuilder.js` et `lib/queueBuilder.js`

Constructeurs pour les systèmes de workers et files d'attente. `workerBuilder` crée un acteur instanciable avec un mode d'ordonnancement `background`, tandis que `queueBuilder` crée un singleton qui souscrit à un événement et distribue les jobs via une `JobQueue`.

- **`queueBuilder(queueName, config)`** — Crée une file d'attente avec config : `sub` (topic d'événement, obligatoire), `queueSize` (défaut 100), `queueOptions`, `jobIdGetter` (défaut : `msg.id`).
- **`workerBuilder(queueName, config)`** — Crée un worker avec config : `workQuest` (fonction de traitement obligatoire).

### `lib/smartId.js`

Utilitaire pour la gestion des identifiants d'acteurs au format `type@uid`. Fournit l'encodage/décodage sécurisé des identifiants externes (encodage URI avec remplacement des caractères `-_.!~*'()`).

#### Méthodes publiques

- **`SmartId.encode(externalId)`** — Encode un identifiant externe pour usage dans les IDs Xcraft.
- **`SmartId.decode(id)`** — Décode un identifiant Xcraft.
- **`SmartId.from(type, externalId, encode=true)`** — Crée un ID complet `type@encodedId`.
- **`SmartId.toExternalId(id)`** — Extrait et décode la partie externe d'un ID.
- **`SmartId.getUid(id)`** — Extrait la partie UID d'un identifiant.
- **`isValid()`** — Valide le format selon le type attendu.
- **`isMalformed()`** — Inverse de `isValid()`.
- **`hasUid()`** — Vérifie la présence d'une partie UID.

### `lib/cache/index.js`

Gestionnaire de cache avec TTL et système de ranking. Permet de limiter le nombre d'instances d'acteurs en mémoire avec éviction automatique des moins utilisés. Utilise directement le store Redux du goblin-cache (sans passer par le bus) pour les opérations de mise à jour.

#### Méthodes publiques

- **`CacheLib.update(goblinId, TTL)`** — Met à jour le TTL d'un acteur ; un délai de 0 supprime l'entrée.
- **`CacheLib.rank(goblinName, goblinId, size)`** — Ajoute un acteur au système de ranking avec taille de cache.

### `lib/cache/cache.js`

Implémentation du service de cache avec gestion des timeouts, ranking des instances (`RankedCache`), et métriques. Utilise une structure d'état privée non exposée au warehouse.

#### État et modèle de données

- `private.goblins` : Map des handles de timeouts actifs par goblinId
- `private.cache` : Map des instances `RankedCache` par goblinName
- `private.items` : Map des items dans les caches par goblinId

### `lib/cryo/manager.js`

Gestionnaire centralisé pour les opérations Cryo. Fournit une interface unifiée pour la lecture, recherche, et synchronisation des données persistées. Maintient des instances de lecteurs/chercheurs par base de données pour optimiser les connexions SQLite. La méthode `syncBroadcast` émet un événement `cryo-db-synced` avec debouncing (500ms).

#### Méthodes publiques

- **`reader(quest, db)`** — Retourne un `CryoReader` pour la base de données.
- **`fullTextSearcher(quest, db)`** — Retourne un `CryoSearch` pour les requêtes FTS/vectorielles.
- **`search(quest, db, searchQuery, limit)`** — Recherche textuelle simple.
- **`search2(quest, db, searchQuery, locales, scopes, limit)`** — Recherche textuelle avec filtres locales/scopes et scoring normalisé.
- **`searchDistance(quest, db, vectors, limit)`** — Recherche vectorielle par similarité.
- **`searchDistance2(quest, db, vectors, locales, scopes, limit)`** — Recherche vectorielle avec filtres.
- **`getDistinctScopes(quest, db)`** — Récupère tous les scopes distincts.
- **`searchRaw(quest, db, pattern, regex, options)`** — Recherche brute avec expressions régulières.
- **`getState(quest, db, goblinId, shape, type)`** — Récupère l'état d'un acteur depuis Cryo.
- **`getIds(quest, db, goblinType, options)`** — Itère sur les IDs d'un type d'acteur.
- **`pickAction(quest, db, id, properties)`** — Récupère des propriétés spécifiques d'une action.
- **`isPersisted(quest, db, goblinId)`** — Vérifie si un acteur a au moins une action `persist`.
- **`isPublished(quest, db, goblinId)`** — Vérifie si un acteur est dans `lastPersistedActions`.
- **`commitStatus(quest, db, goblinId)`** — Retourne `'none'`, `'staged'` ou `'commited'`.
- **`syncBroadcast(db)`** — Diffuse un événement de synchronisation (debounced 500ms).

### `lib/cryo/reader.js`

Lecteur SQLite pour les bases de données Cryo. Étend `SQLite` de `xcraft-core-book`. Fournit des méthodes optimisées pour lire les états d'acteurs et effectuer des requêtes typées via `QueryBuilder`. Supporte les requêtes exécutées dans un worker thread via Piscina (`queryWorkerStream`) pour ne pas bloquer le thread principal.

#### Méthodes publiques

- **`getGoblinState(goblinId, type='persist')`** — Récupère l'état d'un acteur spécifique.
- **`getGoblinIds(goblinType, options)`** — Itère sur les IDs d'acteurs (générateurs).
- **`queryArchetype(goblinType, shape, noAttach=false)`** — Retourne un `FromQuery` typé pour requêter via `xcraft-core-pickaxe`. Le troisième argument `noAttach` permet de désactiver les attachements automatiques de bases (utile pour les workers).
- **`queryWorkerStream(query)`** — Exécute une requête `FinalQuery` dans un worker thread Piscina et retourne un stream de lignes. Idéal pour les requêtes volumineuses sans bloquer le thread principal.
- **`queryEmbeddings(vectors)`** — Retourne un `QueryBuilder` pour les recherches vectorielles.
- **`pickAction(id, properties)`** — Récupère des propriétés JSON spécifiques d'une action.
- **`isPersisted(goblinId)`** — Vérifie la présence d'une action `persist`.
- **`isPublished(goblinId)`** — Vérifie la présence dans `lastPersistedActions`.
- **`commitStatus(goblinId)`** — Retourne `'none'`, `'staged'` ou `'commited'`.
- **`attachReader(reader)`** — Attache une autre base de données pour les requêtes cross-DB.
- **`attachDB(dbName, alias)`** — Attache une base par son nom et alias (mode lecture seule via URI).
- **`iterateQuery(sql)`** — Exécute une requête SQL personnalisée (générateur).
- **`normalizeFileName(fileName)`** — Normalise un nom de fichier (caractères interdits et noms réservés Windows).

### `lib/cryo/search.js`

Moteur de recherche pour les bases de données Cryo. Implémente la recherche textuelle FTS5 et vectorielle (sqlite-vec) avec support pour les locales, scopes, et scoring normalisé.

#### Méthodes publiques

- **`search(searchQuery, limit=100)`** — Recherche FTS5 simple (générateur de goblinId).
- **`search2(searchQuery, locales, scopes, limit=100)`** — Recherche FTS5 avec scoring normalisé (générateur d'objets `{documentId, locale, scope, data, rawScore, normScore}`).
- **`searchDistance(vectors, limit=100)`** — Recherche vectorielle (générateur d'objets avec `distance`).
- **`searchDistance2(vectors, locales, scopes, limit=100)`** — Recherche vectorielle avec filtres.
- **`getDistinctScopes()`** — Itère sur les scopes distincts.
- **`searchRaw(patterns, regex, options)`** — Recherche brute sur les actions avec extraction par regex (générateur de `{id, refs[]}`). L'option `last` utilise la table `lastPersistedActions`.

### `lib/cryo/shapes.js`

Définitions des shapes pour les structures de données Cryo utilisées dans `QueryBuilder`.

- **`LastPersistedActionShape(shape)`** — Shape pour les actions dans `lastPersistedActions` avec état typé.
- **`EmbeddingsShape`** — Shape pour les données d'embeddings vectoriels.

### `lib/cryo/workers/sql.js`

Worker Piscina pour l'exécution de requêtes SQL en dehors du thread principal. Reçoit une requête sérialisée (`FinalQuery.json()`), ouvre une connexion SQLite en lecture seule, et envoie les résultats via un `MessagePort` sous forme de stream. Utilisé par `CryoReader.queryWorkerStream`.

### `lib/sync/index.js` et `lib/sync/hordesSync.js`

Système de synchronisation distribuée. `HordesSync` gère le bootstrap (récupération initiale) et la synchronisation incrémentale entre nœuds via `xcraft-core-horde`. Il surveille la qualité de la connexion socket (`<perf>` events) et relance automatiquement les syncs après reconnexion ou après un lag de 30 secondes.

Lors du bootstrap, si le dernier `commitId` local n'est pas reconnu par le serveur, la base est renommée et un bootstrap complet est effectué. Le timeout `maxLagDeltaTime` est élevé à 4 minutes pendant le bootstrap.

#### Méthodes publiques (HordesSync)

- **`boot()`** — Initialise avec bootstrap des bases vides ou incompatibles ; émet `goblin.hordesSync-initialized`.
- **`sync(db)`** — Lance la synchronisation incrémentale d'une base (debounced 500ms dans `Sync`).

### `lib/elf/index.js`

Nouvelle génération d'acteurs avec API moderne basée sur les classes et proxies JavaScript. Simplifie la création d'acteurs avec gestion automatique de l'état, intégration Cryo native, et API fluide.

Les deux modèles de base sont `Elf` (instanciable, avec `create`) et `Elf.Alone` (singleton, avec `init`). La persistance est activée via `Elf.Archetype` (logique) qui enregistre automatiquement les quêtes `persist`, `insertOrCreate`, `insertOrReplace`, et `$4ellen`.

La propriété statique `noHistory` sur une classe `Archetype` permet de ne conserver que la dernière action `persist` (mode `last`) au lieu de tout l'historique (mode `all`).

La propriété statique `indices` sur une classe `Archetype` permet de déclarer des indices SQLite pour améliorer les performances des requêtes `queryArchetype`.

#### Méthodes publiques statiques

- **`Elf.configure(elfClass, logicClass)`** — Configure un acteur Elf : enregistre toutes les quêtes, handlers Redux, et ripley.
- **`Elf.birth(elfClass, logicClass)`** — Enregistre la classe et retourne la fonction de configuration pour `xcraftCommands`.
- **`Elf.trial(logicClass)`** — Crée une instance de logique pour les tests unitaires (sans infrastructure Xcraft).
- **`Elf.newId(type)`** — Génère un identifiant `type@uuid`.
- **`Elf.uuid()`** — Génère un UUID v4.
- **`Elf.id(id)`** — Aide au typage des identifiants (identité).
- **`Elf.Sculpt(type)`** — Crée une classe d'état typée à partir d'un shape Stone.
- **`Elf.createFeed(prefix)`** — _(Déprécié)_ Crée un feed système temporaire.
- **`Elf.getLogic(logicClass)`** — Instancie une classe de logique.
- **`Elf.getClass(type)`** — Récupère la classe Elf enregistrée pour un type.
- **`Elf.quests(elfClass)`** — Retourne la liste des noms de quêtes d'une classe.
- **`Elf.goblinName(derivatedClass)`** — Extrait le goblinName (première lettre en minuscule).

#### Méthodes d'instance (dans les quêtes)

- **`this.newQuestFeed(prefix)`** — Crée un feed temporaire avec nettoyage automatique via `quest.defer`. Ne peut pas être appelé depuis une quête `create`.
- **`this.killFeed(feedId, xcraftRPC)`** — Supprime un feed et tous ses acteurs.
- **`this.kill(ids, parents, feed, xcraftRPC)`** — Supprime des acteurs spécifiques.
- **`this.persist()`** — Persiste l'état (Archetype uniquement).
- **`this.insertOrCreate(id, desktopId, state, commitId)`** — Insère un état si l'acteur n'existe pas, sinon retourne `undefined`.
- **`this.insertOrReplace(id, desktopId, state)`** — Insère ou remplace un état.
- **`this.api(id)`** — Retourne l'API d'un acteur existant avec injection de l'état local.
- **`this.winDesktopId()`** — Retourne le desktopId d'une fenêtre locale ou distante.

### `lib/elf/spirit.js`

Système de proxies pour la gestion d'état des acteurs Elf. Traduit les opérations JavaScript naturelles (lecture, écriture, suppression, itération) en opérations sur structures Immutable.js. Supporte les listes, objets imbriqués, et types primitifs.

#### Méthodes publiques

- **`Spirit.from(sculptedClass)`** — Crée un proxy Spirit à partir d'une classe sculptée et d'un Shredder.

### `lib/elf/traps.js`

Collection de proxies pour différents contextes d'exécution Elf. Gère l'interception des appels de méthodes selon le côté (serveur `directTraps` vs client `forwardTraps`), la transformation des reducers (`logicTraps`), et l'accès à l'état immutable (`stateTraps`, `mapTraps`).

- **`logicTraps`** — Pour les appels `this.logic.xxx()` : calcule le payload en comparant les arguments aux données du message. Les arguments identiques à ceux du message courant sont omis (seules les surcharges sont transmises).
- **`stateTraps`** — Pour l'accès aux propriétés d'état avec conversion vers `List` ou objets proxifiés.
- **`mapTraps`** — Pour l'énumération (`Object.keys`, `Object.values`) des objets immutables.
- **`directTraps`** — Pour les appels directs côté serveur (dans `$4ellen` et similaires).
- **`forwardTraps`** — Pour les appels via bus côté client ; mappe les arguments nommés, gère `create`/`insertOrCreate`/`insertOrReplace`.
- **`meTraps`** — Pour `this._me()` : retourne l'API `quest.me` de l'acteur courant.

### `lib/elf/me.js`

Wrapper pour l'API `quest.me` des acteurs Elf. Fournit une interface unifiée qui combine les méthodes du Quest et celles de l'instance Elf avec gestion automatique du contexte. Expose également l'accès au `CryoManager` via `this.cryo`.

#### Méthodes publiques

- **`newQuestFeed(prefix)`** — Crée un feed temporaire avec nettoyage automatique.
- **`killFeed(feedId, xcraftRPC)`** — Supprime un feed.
- **`kill(ids, parents, feed, xcraftRPC)`** — Supprime des acteurs.
- **`persist(...args)`** — Persiste l'état avec synchronisation automatique.
- **`Me.createFeed(prefix)`** _(statique)_ — Crée un identifiant de feed `system@[prefix@]uuid`.

### `lib/elf/runner.js`

Runner de tests pour les acteurs Elf. Initialise un serveur Xcraft complet via `xcraft-core-host` et fournit un contexte de quête pour l'exécution des tests. Nettoie le répertoire de configuration entre les runs (si le chemin se termine par `-test`).

#### Méthodes publiques

- **`init()`** — Initialise l'environnement de test Xcraft (idempotent, gère le timeout de dispose).
- **`dispose()`** — Déclenche l'arrêt du serveur (avec délai de 2s). Peut être désactivé via `GOBLIN_RUNNER_SHUTDOWN=no`.
- **`it(callback)`** — Exécute un test avec le contexte `Me` disponible via `this`.

### `lib/elf/list.js`

Wrapper pour les arrays de l'état des acteurs Elf. Implémente le protocole d'itération (`Symbol.iterator`) et les méthodes communes tout en maintenant l'immutabilité du Shredder sous-jacent.

#### Méthodes publiques

- **`push(...args)`** — Ajoute des éléments à la liste.
- **`map(func)`** — Transforme les éléments et retourne un array JavaScript.
- **`deleteByValue(value)`** — Supprime un élément par sa valeur.
- **`indexOf(value)`** — Retourne l'index d'un élément.
- **`includes(...args)`** — Vérifie la présence d'un élément.

### `lib/elf/utils.js`

Fonctions utilitaires pour l'introspection des classes Elf.

- **`getProperties(obj)`** — Propriétés (non-fonctions) d'un objet.
- **`getAllFuncs(obj, depth=2)`** — Toutes les fonctions jusqu'à la profondeur d'héritage.
- **`checkId(id, goblinName)`** — Valide le format d'un ID selon le type d'acteur attendu.

### `lib/elf/params.js` et `lib/elf/cacheParams.js`

Cache pour les paramètres des quêtes et reducers. Évite la réflexion répétée sur les signatures de fonctions. `CacheParams` maintient deux registres : `cacheQuestParams` (paramètres des quêtes Elf) et `cacheReduceParams` (paramètres des reducers de logique).

#### Méthodes publiques (CacheParams)

- **`register(goblinName, questName, params)`** — Enregistre les paramètres d'une quête/reducer.
- **`get(goblinName, questName)`** — Récupère les paramètres.
- **`know(goblinName)`** — Vérifie si un goblin est connu.

### `lib/types.js`

Définitions de types spécialisés pour le système Xcraft, basées sur `xcraft-core-stones`.

- **`IdType`** — Type pour les identifiants au format `` `type@${string}` `` avec validation du préfixe.
- **`id(name)`** — Factory pour créer des types d'identifiants typés.
- **`MetaShape`** — Shape pour les métadonnées : `index`, `locale`, `scope`, `vectors` (embeddings), `status` (published/trashed/archived).
- **`ChunkShape`** — Shape pour les chunks d'embeddings : `chunk` et `embedding`.

### `lib/capsAndSkills.js`

Système de capacités et compétences pour le Guild Enforcer. `Capability` gère la création, délégation (avec TTL optionnel) et révocation de capacités stockées dans des `WeakMap`. `SkillsSet` définit les contrats de compétences requis pour accéder à une ressource.

#### Méthodes publiques

- **`Capability.create(goblin, name, delegatable=false, owner=null)`** — Crée une capacité pour un acteur.
- **`Capability.delegate(cap, goblin, ttl=0, delegatable=false)`** — Délègue une capacité avec révocation automatique.
- **`Capability.enable(cap)`** / **`Capability.disable(cap)`** — Active/désactive une capacité.
- **`Capability.fulfill(goblin, quest)`** — Vérifie si un goblin satisfait le contrat d'une quête.
- **`SkillsSet.define(refToProtect, skills)`** — Définit un ensemble de compétences requises.

### `lib/osInfo.js`

Informations système normalisées (hostname et username en minuscules, `@` remplacé par `-`) pour la génération d'empreintes d'utilisateurs invités.

### `lib/scheduler-queue.js`

File d'attente avancée pour le scheduler. Implémente trois listes internes (parallel, serie, immediate) avec émission d'événements `awake` pour le dispatch. La liste `immediate` prend toujours la priorité et débloque la liste principale si mise en pause.

#### Méthodes publiques

- **`pause()`** — Met en pause le traitement (parallel et serie).
- **`resume()`** — Reprend le traitement.

### `lib/questTracer.js`

Traceur pour analyser les appels entre acteurs (désactivé par défaut via commentaire dans `lib/quest.js`). Génère un graphe des dépendances au format Cytoscape en excluant `warehouse`, `goblin`, et `workshop`.

- **`trace(fromNamespace, toNamespace)`** — Enregistre un appel entre deux namespaces.
- **`graph`** — Tableau de nœuds et liens au format Cytoscape.

### `lib/goblin-orc.js`

Acteur Goblin simple pour représenter les connexions bus (orcs). Fournit un stockage clé-valeur pour les métadonnées des connexions, créé et supprimé dynamiquement par le service principal lors des événements `<axon-orc-added>` et `<axon-orc-removed>`.

#### État et modèle de données

- `id` : Identifiant de l'orc
- `data` : Map clé-valeur pour les métadonnées

#### Quêtes publiques

- **`create()`** — Initialise un nouvel orc.
- **`setData(key, data)`** — Stocke une donnée.
- **`delete()`** — Supprime l'orc.

### `lib/shield/db.js`

Base de données SQLite pour le cache persistant des utilisateurs du Guild Enforcer. Utilise des triggers SQLite (`shield_insert`, `shield_update`, `shield_delete`) pour synchroniser avec le registre en mémoire lors des opérations sur la base.

#### Méthodes publiques

- **`get(id)`** — Récupère un utilisateur par son ID.
- **`save(id, data)`** — Sauvegarde ou met à jour un utilisateur.
- **`delete(id)`** — Supprime un utilisateur.
- **`deleteAll()`** — Supprime tous les utilisateurs.

### `lib/ripley/cryo.js`

Backend Cryo pour le système Ripley. Gère la persistance des actions Redux via le service Cryo (appel `cryo.freeze`). Stocke la dernière action persistée dans `lastPersistedAction` et émet l'événement `<goblin-commitId-freezed>` pour coordonner les attentes (`callAndWait`).

#### Méthodes publiques

- **`ripley(db, dispatch)`** — Rejoue les actions depuis Cryo (subscribe à `cryo.thawed.{db}`).
- **`persist(action, rules)`** — Persiste une action via `cryo.freeze`.
- **`hasMode(mode)`** — Vérifie si un mode est supporté (`allbykeys`, `all`, `last`).
- **`ellen(state, action)`** — Reducer pour l'état Ellen (retourne l'état sans modification).

### `lib/test.js`

Point d'entrée pour les tests. Configure l'environnement Xcraft (`XCRAFT_ROOT`, `GOBLINS_APP`) et exporte le module principal pour utilisation dans les suites de tests.

## Licence

Ce module est distribué sous [licence MIT](./LICENSE).

---

_Ce contenu a été généré par IA_

[xcraft-core-bus]: https://github.com/Xcraft-Inc/xcraft-core-bus
[xcraft-core-cryo]: https://github.com/Xcraft-Inc/xcraft-core-cryo
[goblin-warehouse]: https://github.com/Xcraft-Inc/goblin-warehouse
[xcraft-core-shredder]: https://github.com/Xcraft-Inc/xcraft-core-shredder
[xcraft-core-stones]: https://github.com/Xcraft-Inc/xcraft-core-stones
[xcraft-core-horde]: https://github.com/Xcraft-Inc/xcraft-core-horde
[goblin-laboratory]: https://github.com/Xcraft-Inc/goblin-laboratory
