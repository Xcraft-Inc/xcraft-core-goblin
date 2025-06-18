# 📘 Documentation du module xcraft-core-goblin

## Aperçu

Le module `xcraft-core-goblin` est le cœur du framework Xcraft, fournissant une API pour créer des microservices basés sur Redux appelés "Goblins". Il implémente un système d'acteurs avec gestion d'état immutable, persistance via Cryo, et communication par bus de messages. Le module offre deux types d'acteurs principaux : les acteurs Goblin (legacy) et les acteurs Elf (moderne), avec support pour la sécurité via le Guild Enforcer et la synchronisation distribuée.

Une documentation présentant les acteurs Elf pas à pas est disponible sur le site Xcraft à l'adresse suivante : http://xcraft.ch/elves/

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

## Fonctionnement global

### Architecture des acteurs

Le framework propose deux modèles d'acteurs :

1. **Acteurs Goblin (legacy)** : Utilisent des générateurs et le pattern Redux classique
2. **Acteurs Elf** : API moderne avec classes, proxies et gestion automatique de l'état

### Cycle de vie des acteurs

- **Singleton** : `boot`/`init` → quêtes → `dispose`
- **Instanciable** : `create` → quêtes → `delete` → `dispose`

### Gestion d'état

L'état des acteurs est géré via Shredder (wrapper Immutable.js) avec :

- Mutations atomiques via reducers
- Persistance automatique via Ripley/Cryo
- Synchronisation temps réel entre clients/serveurs

### Sécurité

Le Guild Enforcer contrôle l'accès aux quêtes via :

- Système de capacités (capabilities)
- Rôles et compétences (skills)
- Authentification JWT
- Politique de sécurité configurable

## Exemples d'utilisation

### Acteur Elf moderne

```javascript
const {Elf} = require('xcraft-core-goblin');
const {string, option, number} = require('xcraft-core-stones');

// Forme de l'état (avec typage)
class MyLogicShape {
  id = string;
  data = option(number);
}

class MyLogicState extends Elf.Sculpt(MyLogicShape) {}

// Logique d'état (avec persistance)
class MyLogic extends Elf.Archetype {
  static db = 'myapp';
  state = new MyLogicState();

  create(id, data) {
    const {state} = this;
    state.id = id;
    state.data = data;
  }

  updateData(data) {
    const {state} = this;
    state.data = data;
  }
}

// Définition de l'acteur
class MyActor extends Elf {
  logic = Elf.getLogic(MyLogic);
  state = new MyLogicState();

  async create(id, desktopId, initialData) {
    this.logic.create(id, initialData);
    await this.persist();
    return this;
  }

  async updateData(newData) {
    this.logic.updateData(newData);
    await this.persist();
  }

  delete() {
    // Nettoyage automatique
  }
}

// Configuration
exports.xcraftCommands = Elf.birth(MyActor, MyLogic);
```

### Utilisation d'un acteur

```javascript
// Dans une quête
const feedId = await this.newQuestFeed();
const actor = await new MyActor(this).create('myactor@123', feedId, 42);
await actor.updateData(84);
```

### Acteur Goblin legacy

```javascript
const logicState = {
  id: null,
  counter: 0,
};

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

## Interactions avec d'autres modules

- **[xcraft-core-bus]** : Communication inter-acteurs et routage des messages
- **[xcraft-core-cryo]** : Persistance et synchronisation des états
- **[goblin-warehouse]** : Gestion des relations parent-enfant et feeds
- **[xcraft-core-shredder]** : Structures de données immutables
- **[goblin-laboratory]** : Composants UI React pour les widgets

## Configuration avancée

| Option                     | Description                                     | Type      | Valeur par défaut |
| -------------------------- | ----------------------------------------------- | --------- | ----------------- |
| `enableCryo`               | Active le stockage d'actions via Cryo           | `boolean` | `false`           |
| `actionsSync.enable`       | Active la synchronisation des actions pour Cryo | `boolean` | `false`           |
| `actionsSync.excludeDB`    | Liste des bases de données exclues de la sync   | `array`   | `[]`              |
| `enableGuildEnforcerCache` | Active le cache SQLite du guild enforcer        | `boolean` | `false`           |

### Variables d'environnement

| Variable                 | Description                                            | Exemple       | Valeur par défaut |
| ------------------------ | ------------------------------------------------------ | ------------- | ----------------- |
| `GOBLIN_ENFORCER_LOOSE`  | Désactive le verrouillage du guild enforcer            | `true`        | `undefined`       |
| `NODE_ENV`               | Mode de développement pour validations supplémentaires | `development` | `undefined`       |
| `GOBLIN_RUNNER_SHUTDOWN` | Contrôle l'arrêt automatique du runner de tests        | `no`          | `undefined`       |

## Détails des sources

### `config.js`

Configuration du module via xcraft-core-etc avec options pour Cryo, synchronisation d'actions et cache du guild enforcer.

### `goblin-cache.js`

Point d'entrée pour les commandes du service de cache. Expose les commandes définies dans `lib/cache/cache.js`.

### `goblin-orc.js`

Point d'entrée pour les commandes du service goblin-orc. Expose les commandes définies dans `lib/goblin-orc.js`.

### `goblin-registry.js`

Service de registre pour accéder à l'état des goblins. Fournit la commande `getState` pour récupérer l'état d'un goblin par son ID, avec gestion des erreurs et support multi-tribe.

### `goblin.js`

Point d'entrée principal pour les commandes du service goblin. Expose les commandes définies dans `lib/service.js`.

### `lib/index.js`

Classe principale Goblin qui implémente le système d'acteurs legacy. Gère la création d'instances, l'exécution des quêtes via Redux, la persistance Ripley, et l'intégration avec le scheduler. Fournit l'API de base pour `quest.create`, `quest.cmd`, et la gestion du cycle de vie des acteurs.

#### État et modèle de données

L'état des Goblins est géré via Shredder avec une structure Redux :

- `logic` : État métier de l'acteur
- `ellen` : État de persistance Ripley

#### Méthodes publiques

- **`configure(goblinName, logicState, logicHandlers, goblinConfig)`** — Configure un nouveau type d'acteur Goblin avec son état initial et ses reducers Redux.
- **`registerQuest(goblinName, questName, quest, options)`** — Enregistre une quête (méthode) pour un type d'acteur donné.
- **`create(goblinName, uniqueIdentifier, generation)`** — Crée une nouvelle instance d'acteur avec un identifiant unique et une génération.
- **`release(goblinName, goblinId)`** — Libère une instance d'acteur et nettoie ses ressources.
- **`getGoblinsRegistry()`** — Retourne le registre global de tous les acteurs instanciés.
- **`buildApplication(appId, config)`** — Construit une application Xcraft complète avec configuration par défaut.
- **`buildQueue(queueName, config)`** — Construit un système de file d'attente pour le traitement en arrière-plan.
- **`buildQueueWorker(queueName, config)`** — Construit un worker pour traiter les tâches d'une file d'attente.
- **`identifyUser(msg)`** — Identifie un utilisateur à partir d'un message du bus.
- **`setUser(context, userId)`** — Définit l'utilisateur courant dans un contexte de quête.
- **`enroleUser(instance, tokenData)`** — Enregistre un utilisateur à partir d'un token JWT.
- **`deroleUser(instance, tokenData)`** — Supprime un utilisateur du système.
- **`registerUser(userInfos)`** — Enregistre manuellement un utilisateur.
- **`buildGuestFootprint(clientServiceId, windowId)`** — Construit une empreinte pour un utilisateur invité local.
- **`buildRemoteGuestFootprint(ctx)`** — Construit une empreinte pour un utilisateur invité distant.
- **`waitForHordesSync(quest)`** — Attend la synchronisation des hordes avant de continuer.
- **`dispose()`** — Nettoie toutes les ressources du système.

### `lib/quest.js`

Contexte d'exécution pour les quêtes d'acteurs. Fournit l'API complète pour interagir avec d'autres acteurs, gérer les événements, accéder aux services système, et manipuler l'état. Centralise toutes les opérations disponibles dans une quête.

#### Méthodes publiques

- **`create(namespace, args)`** — Crée un nouvel acteur et retourne son API.
- **`createFor(goblinName, goblinId, namespace, args)`** — Crée un acteur avec un propriétaire spécifique.
- **`createNew(namespace, args)`** — Crée un nouvel acteur avec un ID généré automatiquement.
- **`createView(namespace, args, view)`** — Crée un acteur avec une vue spécifique (filtrage des propriétés).
- **`createPlugin(namespace, args)`** — Crée un acteur plugin lié à l'acteur courant.
- **`createEntity(id, properties, view)`** — Crée une entité via goblin-workshop.
- **`createCache(goblinId)`** — Crée ou récupère un service de cache.
- **`cmd(cmd, args)`** — Envoie une commande sur le bus Xcraft.
- **`evt(topic, payload)`** — Émet un événement avec le préfixe de l'acteur.
- **`sub(topic, handler)`** — S'abonne à un événement et retourne la fonction de désabonnement.
- **`do(payload)`** — Déclenche le reducer correspondant à la quête courante.
- **`doSync(action)`** — Déclenche un reducer et synchronise immédiatement l'état.
- **`dispatch(type, payload, meta, error)`** — Déclenche un reducer spécifique avec des données.
- **`getAPI(id, namespace, withPrivate, autoSysCall)`** — Retourne l'API d'un acteur pour interagir avec lui.
- **`getState(goblinId)`** — Récupère l'état d'un acteur, même sur d'autres tribes.
- **`isAlive(goblinId)`** — Vérifie si un acteur est vivant et créé.
- **`kill(ids, parents, feed)`** — Détache et supprime des acteurs.
- **`release(goblinId)`** — Libère un acteur via le système d'événements.
- **`cancel()`** — Annule l'exécution de la quête courante.
- **`fireAndForget()`** — Marque la quête comme fire-and-forget (pas de réponse).
- **`isCanceled(result)`** — Vérifie si un résultat indique une annulation.
- **`go(cmd, cmdArgs, delay)`** — Exécute une commande de manière asynchrone avec délai optionnel.
- **`defer(action)`** — Ajoute une action à exécuter à la fin de la quête.
- **`fail(title, desc, hint, ex)`** — Signale un échec avec notification desktop.
- **`logCommandError(ex, msg)`** — Log une erreur de commande pour overwatch.
- **`sysCall(questName, questArguments)`** — Appelle une quête système sur l'acteur courant.
- **`sysCreate()`** — Crée l'acteur courant dans le feed système.
- **`sysKill()`** — Supprime l'acteur courant du feed système.
- **`getSystemDesktop()`** — Retourne le desktop système correspondant.
- **`getDesktop(canFail)`** — Récupère l'ID du desktop courant.
- **`getSession()`** — Récupère l'ID de session à partir du desktop.
- **`getStorage(service, session)`** — Retourne l'API d'un service de stockage.
- **`hasAPI(namespace)`** — Vérifie si un namespace d'API existe.
- **`newResponse(routing)`** — Crée une nouvelle réponse bus avec routage spécifique.

### `lib/scheduler.js`

Gestionnaire de files d'attente pour l'exécution des quêtes. Implémente trois modes d'exécution (parallèle, série, immédiat) avec gestion des priorités et prévention des deadlocks lors des opérations de création/suppression d'acteurs.

#### Méthodes publiques

- **`dispatch(type, payload)`** — Ajoute une quête à la file d'attente appropriée selon son type.

### `lib/guildEnforcer.js`

Système de sécurité pour contrôler l'accès aux quêtes. Implémente un modèle de capacités avec rôles, compétences, et authentification JWT. Gère les utilisateurs invités et les politiques de sécurité configurables avec cache SQLite optionnel.

#### Méthodes publiques

- **`shield(cmd, quest, skills)`** — Protège une quête avec des compétences requises.
- **`enforce(object, rank)`** — Assigne un rang et des capacités à un objet.
- **`enroleUser(tokenData)`** — Enregistre un utilisateur à partir d'un token JWT.
- **`deroleUser(tokenData)`** — Supprime un utilisateur du système.
- **`registerUser(userInfos)`** — Enregistre manuellement un utilisateur.
- **`getUser(userId)`** — Récupère un utilisateur par son ID.
- **`isBlocked(goblin, cmd)`** — Vérifie si un acteur peut exécuter une commande.
- **`addGuestUser(footprint)`** — Ajoute un utilisateur invité avec son empreinte.
- **`getRankingPredictions(cmd)`** — Retourne les prédictions de ranking pour une commande.

### `lib/ripley.js`

Système de persistance pour les acteurs. Gère la sérialisation/désérialisation des états via différents backends (Cryo) avec support pour la réplication et la synchronisation temps réel.

#### Méthodes publiques

- **`ripley(store, db, logger)`** — Rejoue les actions persistées dans le store Redux.
- **`persistWith(filters)`** — Middleware Redux pour la persistance automatique selon les filtres.
- **`hasMode(mode)`** — Vérifie si un mode de persistance est supporté.

### `lib/service.js`

Service principal singleton qui gère l'initialisation du système, la synchronisation Ripley, et les métriques. Coordonne les différents composants et fournit les quêtes système pour la gestion des acteurs.

#### Méthodes publiques

- **`ripleyServer(db, actions, commitIds, userId)`** — Traite les actions de synchronisation côté serveur.
- **`ripleyClient(db)`** — Synchronise une base de données côté client.
- **`ripleyCheckBeforeSync(db, noThrow)`** — Vérifie la compatibilité avant synchronisation.
- **`ripleyCheckForCommitId(db, commitIds)`** — Vérifie si des commitIds existent sur le serveur.
- **`ripleyPersistFromZero(db, goblinIds)`** — Vérifie si des actions avec commitId zéro sont persistées.
- **`_ripleyPrepareSync(db)`** — Prépare les données pour la synchronisation.
- **`_ripleyApplyPersisted(db, persisted, newCommitId, rows)`** — Applique les actions persistées reçues.
- **`status()`** — Affiche l'état de tous les acteurs instanciés.
- **`xcraftMetrics()`** — Collecte les métriques système pour monitoring.
- **`tryShutdown(wait)`** — Tente d'arrêter proprement le système.
- **`sysCreate(desktopId, goblinId)`** — Crée un acteur dans le feed système.
- **`sysKill(desktopId, goblinId)`** — Supprime un acteur du feed système.
- **`sysCall(desktopId, goblinId, namespace, questName, questArguments)`** — Appelle une quête sur un acteur système temporaire.
- **`cache-clear()`** — Vide le cache global du système.
- **`getQuestGraph()`** — Retourne le graphe des appels entre quêtes.

### `lib/appBuilder.js`

Constructeur d'applications Xcraft. Simplifie la création d'applications complètes avec configuration par défaut, intégration workshop, et gestion des thèmes. Fournit une API haut niveau pour démarrer rapidement une application.

#### Méthodes publiques

- **Configuration automatique** — Configure automatiquement workshop, desktop, et thèmes selon les options fournies.
- **Gestion des quêtes personnalisées** — Permet d'ajouter des quêtes spécifiques à l'application.
- **Intégration mandate** — Support pour les mandates et configuration multi-tenant.

### `lib/workerBuilder.js` et `lib/queueBuilder.js`

Constructeurs pour les systèmes de workers et files d'attente. Permettent de créer des acteurs spécialisés pour le traitement en arrière-plan avec gestion de la charge et limitation de concurrence.

#### Méthodes publiques

- **`queueBuilder(queueName, config)`** — Crée une file d'attente avec workers automatiques.
- **`workerBuilder(queueName, config)`** — Crée un worker pour traiter les tâches d'une file.

### `lib/smartId.js`

Utilitaire pour la gestion des identifiants d'acteurs. Fournit l'encodage/décodage sécurisé des identifiants externes et la validation des formats d'ID selon les conventions Xcraft.

#### Méthodes publiques

- **`encode(externalId)`** — Encode un identifiant externe pour utilisation sécurisée dans les IDs Xcraft.
- **`decode(id)`** — Décode un identifiant Xcraft vers sa forme externe originale.
- **`from(type, externalId, encode)`** — Crée un ID complet au format `type@encodedId`.
- **`toExternalId(id)`** — Extrait et décode la partie externe d'un ID Xcraft.
- **`getUid(id)`** — Extrait la partie UID d'un identifiant.
- **`isValid()`** — Valide le format d'un identifiant selon le type attendu.
- **`isMalformed()`** — Vérifie si un identifiant est malformé.
- **`hasUid()`** — Vérifie si l'identifiant contient une partie UID.

### `lib/cache/index.js`

Gestionnaire de cache avec TTL et système de ranking. Permet de limiter le nombre d'instances d'acteurs en mémoire avec éviction automatique des moins utilisés.

#### Méthodes publiques

- **`update(goblinId, TTL)`** — Met à jour le TTL d'un acteur dans le cache.
- **`rank(goblinName, goblinId, size)`** — Ajoute un acteur au système de ranking avec taille de cache.

### `lib/cache/cache.js`

Implémentation du service de cache avec gestion des timeouts, ranking des instances, et métriques. Utilise RankedCache pour l'éviction automatique des acteurs les moins utilisés.

#### État et modèle de données

- `private.goblins` : Map des timeouts actifs par goblinId
- `private.cache` : Map des caches RankedCache par goblinName
- `private.items` : Map des items dans les caches par goblinId

#### Méthodes publiques

- **`create()`** — Initialise le service de cache et s'abonne aux événements de nettoyage.
- **`clear()`** — Vide tous les caches et supprime tous les timeouts.
- **`delete()`** — Nettoie le service de cache.

### `lib/cryo/manager.js`

Gestionnaire centralisé pour les opérations Cryo. Fournit une interface unifiée pour la lecture, recherche, et synchronisation des données persistées avec optimisations de performance et gestion des connexions.

#### Méthodes publiques

- **`reader(quest, db)`** — Retourne un lecteur Cryo pour accéder aux données persistées.
- **`fullTextSearcher(quest, db)`** — Retourne un chercheur pour les requêtes full-text et vectorielles.
- **`search(quest, db, searchQuery, limit)`** — Effectue une recherche textuelle dans la base de données.
- **`search2(quest, db, searchQuery, locales, scopes, limit)`** — Recherche textuelle avancée avec filtres.
- **`searchDistance(quest, db, vectors, limit)`** — Recherche vectorielle par similarité.
- **`searchDistance2(quest, db, vectors, locales, scopes, limit)`** — Recherche vectorielle avec filtres.
- **`searchRaw(quest, db, pattern, regex, lastOnly)`** — Recherche brute avec expressions régulières.
- **`getState(quest, db, goblinId, shape, type)`** — Récupère l'état d'un acteur depuis Cryo.
- **`getIds(quest, db, goblinType, options)`** — Récupère la liste des IDs d'un type d'acteur.
- **`queryLastActions(quest, db, goblinType, properties, filters, orderBy)`** — Requêtes SQL complexes sur les dernières actions.
- **`pickAction(quest, db, id, properties)`** — Récupère des propriétés spécifiques d'une action.
- **`isPersisted(quest, db, goblinId)`** — Vérifie si un acteur est persisté.
- **`isPublished(quest, db, goblinId)`** — Vérifie si un acteur est publié (non supprimé).
- **`commitStatus(quest, db, goblinId)`** — Retourne le statut de commit d'un acteur.
- **`syncBroadcast(db)`** — Diffuse un événement de synchronisation pour une base.

### `lib/cryo/reader.js`

Lecteur SQLite pour les bases de données Cryo. Fournit des méthodes optimisées pour lire les états d'acteurs, effectuer des requêtes complexes, et gérer les attachements de bases de données multiples.

#### Méthodes publiques

- **`getGoblinState(goblinId, type)`** — Récupère l'état d'un acteur spécifique.
- **`getGoblinIds(goblinType, options)`** — Itère sur les IDs d'acteurs d'un type donné.
- **`queryLastActions(goblinType, properties, filters, orderBy)`** — Effectue des requêtes SQL complexes sur les dernières actions.
- **`queryArchetype(goblinType, shape)`** — Retourne un QueryBuilder typé pour requêter les acteurs.
- **`queryEmbeddings(vectors)`** — Retourne un QueryBuilder pour les recherches vectorielles.
- **`pickAction(id, properties)`** — Récupère des propriétés spécifiques d'une action.
- **`isPersisted(goblinId)`** — Vérifie si un acteur est persisté dans la base.
- **`isPublished(goblinId)`** — Vérifie si un acteur est publié dans lastPersistedActions.
- **`commitStatus(goblinId)`** — Retourne 'none', 'staged' ou 'commited' selon l'état.
- **`attachReader(reader, name)`** — Attache une autre base de données pour les requêtes cross-DB.
- **`iterateQuery(sql)`** — Exécute une requête SQL personnalisée et itère sur les résultats.
- **`normalizeFileName(fileName)`** — Normalise un nom de fichier pour éviter les caractères interdits.

### `lib/cryo/search.js`

Moteur de recherche pour les bases de données Cryo. Implémente la recherche textuelle (FTS) et vectorielle avec support pour les locales, scopes, et recherche par similarité.

#### Méthodes publiques

- **`search(searchQuery, limit)`** — Recherche textuelle simple avec ranking.
- **`search2(searchQuery, locales, scopes, limit)`** — Recherche textuelle avancée avec filtres et scoring normalisé.
- **`searchDistance(vectors, limit)`** — Recherche vectorielle par similarité cosinus.
- **`searchDistance2(vectors, locales, scopes, limit)`** — Recherche vectorielle avec filtres de locale et scope.
- **`getDistinctScopes()`** — Récupère tous les scopes disponibles dans la base.
- **`searchRaw(pattern, regex, lastOnly)`** — Recherche brute avec expressions régulières sur les actions.

### `lib/cryo/shapes.js`

Définitions des shapes pour les structures de données Cryo. Fournit les types pour les actions persistées et les embeddings vectoriels.

#### Shapes définies

- **`LastPersistedActionShape(shape)`** — Shape pour les actions dans lastPersistedActions avec état typé.
- **`EmbeddingsShape`** — Shape pour les données d'embeddings vectoriels avec métadonnées.

### `lib/sync/index.js` et `lib/sync/hordesSync.js`

Système de synchronisation distribuée pour les bases de données Cryo. Gère la synchronisation temps réel entre serveurs et clients avec détection de déconnexion, bootstrap automatique, et gestion des conflits.

#### Méthodes publiques

- **`sync(db)`** — Lance la synchronisation d'une base de données avec debouncing.
- **`boot()`** — Initialise le système de synchronisation avec bootstrap des bases vides.

### `lib/elf/index.js`

Nouvelle génération d'acteurs avec API moderne basée sur les classes et proxies. Simplifie la création d'acteurs avec gestion automatique de l'état, intégration Cryo native, et API fluide pour les opérations CRUD.

#### État et modèle de données

Les acteurs Elf utilisent des classes sculptées avec validation de types :

- État défini via `Elf.Sculpt()` avec types Stone
- Gestion automatique des mutations via proxies
- Persistance transparente avec `Elf.Archetype`

#### Méthodes publiques

- **`configure(elfClass, logicClass)`** — Configure un acteur Elf avec sa classe de logique associée.
- **`birth(elfClass, logicClass)`** — Enregistre un acteur Elf dans le système et retourne sa fonction de configuration.
- **`trial(logicClass)`** — Crée une instance de test d'une classe de logique pour les tests unitaires.
- **`newId(type)`** — Génère un nouvel identifiant unique pour un type d'acteur donné.
- **`uuid()`** — Génère un UUID v4.
- **`id(id)`** — Fonction d'aide pour le typage des identifiants.
- **`Sculpt(type)`** — Crée une classe d'état typée à partir d'un shape Stone.
- **`createFeed()`** — Crée un feed système temporaire pour la gestion du cycle de vie.
- **`getLogic(logicClass)`** — Instancie une classe de logique.
- **`getClass(type)`** — Récupère la classe d'un type d'acteur Elf.
- **`quests(elfClass)`** — Retourne la liste des quêtes d'une classe Elf.
- **`goblinName(derivatedClass)`** — Extrait le nom du goblin à partir d'une classe.

### `lib/elf/spirit.js`

Système de proxies pour la gestion d'état des acteurs Elf. Traduit les manipulations JavaScript naturelles en opérations sur structures immutables avec support pour les listes, objets, et types complexes.

#### Méthodes publiques

- **`from(sculptedClass)`** — Crée un proxy Spirit à partir d'une classe sculptée et d'un Shredder.

### `lib/elf/traps.js`

Collection de proxies Elf pour différents contextes d'exécution. Gère l'interception des appels de méthodes, la transformation des arguments, et le routage entre client/serveur selon le contexte.

#### Traps disponibles

- **`logicTraps`** — Intercepte les appels aux reducers de logique pour générer les payloads appropriés.
- **`stateTraps`** — Gère l'accès aux propriétés d'état avec conversion automatique vers les types appropriés.
- **`mapTraps`** — Gère l'énumération des propriétés d'objets immutables.
- **`directTraps`** — Pour les appels directs côté serveur.
- **`forwardTraps`** — Pour les appels via le bus côté client.
- **`meTraps`** — Pour l'API `quest.me`.

### `lib/elf/me.js`

Wrapper pour l'API `quest.me` des acteurs Elf. Fournit une interface unifiée pour accéder aux propriétés et méthodes de l'acteur courant avec gestion automatique de l'état et des feeds.

#### Méthodes publiques

- **`newQuestFeed()`** — Crée un feed temporaire avec nettoyage automatique via quest.defer.
- **`killFeed(feedId, xcraftRPC)`** — Supprime un feed et tous ses acteurs.
- **`kill(ids, parents, feed, xcraftRPC)`** — Supprime des acteurs spécifiques.
- **`persist(...args)`** — Persiste l'état de l'acteur avec synchronisation automatique.
- **`createFeed()`** — Méthode statique pour créer un feed temporaire.

### `lib/elf/runner.js`

Runner de tests pour les acteurs Elf. Permet d'exécuter des tests unitaires avec un environnement Xcraft complet, incluant l'initialisation du serveur et la gestion du cycle de vie.

#### Méthodes publiques

- **`init()`** — Initialise l'environnement de test Xcraft.
- **`dispose()`** — Nettoie l'environnement et arrête le serveur.
- **`it(callback)`** — Exécute un test avec le contexte quest disponible.

### `lib/elf/list.js`

Wrapper pour les arrays utilisés dans l'état des acteurs Elf. Fournit une interface familière pour manipuler les listes tout en maintenant l'immutabilité.

#### Méthodes publiques

- **`push(...args)`** — Ajoute des éléments à la fin de la liste.
- **`map(func)`** — Transforme chaque élément et retourne un array JavaScript.
- **`deleteByValue(value)`** — Supprime un élément par sa valeur.
- **`indexOf(value)`** — Retourne l'index d'un élément.
- **`includes(...args)`** — Vérifie si la liste contient un élément.

### `lib/elf/utils.js`

Fonctions utilitaires pour le système Elf. Fournit des helpers pour l'introspection des classes et la validation des identifiants.

#### Méthodes publiques

- **`getProperties(obj)`** — Récupère la liste des propriétés (non-fonctions) d'un objet.
- **`getAllFuncs(obj, depth)`** — Récupère toutes les fonctions d'un objet avec profondeur d'héritage.
- **`checkId(id, goblinName)`** — Valide qu'un ID correspond au type d'acteur attendu.

### `lib/elf/params.js`

Cache pour les paramètres des quêtes et reducers. Optimise les performances en évitant la réflexion répétée sur les signatures de fonctions.

### `lib/elf/cacheParams.js`

Implémentation du cache de paramètres avec registre par goblin et par quête.

#### Méthodes publiques

- **`register(goblinName, questName, params)`** — Enregistre les paramètres d'une quête.
- **`get(goblinName, questName)`** — Récupère les paramètres d'une quête.
- **`know(goblinName)`** — Vérifie si un goblin est connu dans le cache.

### `lib/types.js`

Définitions de types et shapes pour le système Xcraft. Fournit des types spécialisés comme `IdType` pour les identifiants d'acteurs et `MetaShape` pour les métadonnées avec support de validation.

#### Types disponibles

- **`IdType`** — Type pour les identifiants au format `type@uid`.
- **`id(name)`** — Factory pour créer des types d'identifiants typés.
- **`MetaShape`** — Shape pour les métadonnées avec index, locale, scope, vectors et status.

### `lib/capsAndSkills.js`

Système de capacités et compétences pour le Guild Enforcer. Implémente un modèle de sécurité basé sur les capacités avec délégation, révocation, et vérification des permissions.

#### Méthodes publiques

- **`Capability.create(goblin, name, delegatable, owner)`** — Crée une nouvelle capacité pour un acteur.
- **`Capability.delegate(cap, goblin, ttl, delegatable)`** — Délègue une capacité à un autre acteur avec TTL optionnel.
- **`Capability.enable(cap)`** — Active une capacité.
- **`Capability.disable(cap)`** — Désactive une capacité.
- **`Capability.fulfill(goblin, quest)`** — Vérifie si un goblin peut exécuter une quête.
- **`SkillsSet.define(refToProtect, skills)`** — Définit un ensemble de compétences requises pour protéger une ressource.

### `lib/osInfo.js`

Utilitaires pour récupérer les informations système. Fournit des informations sur l'hôte et l'utilisateur pour la génération d'empreintes d'utilisateurs invités.

#### Exports

- **`guestHost`** — Nom d'hôte nettoyé pour les empreintes.
- **`guestUser`** — Nom d'utilisateur nettoyé pour les empreintes.

### `lib/ripleyHelpers.js`

Fonctions utilitaires pour le système Ripley. Contient des algorithmes pour calculer les étapes de synchronisation optimales en préservant l'intégrité des commits.

#### Méthodes publiques

- **`computeRipleySteps(persisted, commitCnt, limit)`** — Calcule les étapes de synchronisation en respectant l'intégrité des commitId.

### `lib/scheduler-queue.js`

File d'attente avancée pour le scheduler. Implémente trois modes d'exécution (parallèle, série, immédiat) avec gestion des priorités et contrôle de flux.

#### Méthodes publiques

- **`pause()`** — Met en pause le traitement de la file.
- **`resume()`** — Reprend le traitement de la file.

### `lib/questTracer.js`

Traceur pour analyser les appels entre acteurs. Génère un graphe des dépendances pour le debugging et l'optimisation des performances.

#### Exports

- **`trace(fromNamespace, toNamespace)`** — Enregistre un appel entre deux namespaces.
- **`graph`** — Graphe des appels au format Cytoscape.

### `lib/goblin-orc.js`

Acteur simple pour gérer les données des orcs (instances de bus). Fournit un stockage clé-valeur basique pour les métadonnées des connexions.

#### État et modèle de données

- `id` : Identifiant de l'orc
- `data` : Stockage clé-valeur pour les métadonnées

#### Méthodes publiques

- **`create()`** — Initialise un nouvel orc.
- **`setData(key, data)`** — Stocke une donnée avec une clé.
- **`delete()`** — Supprime l'orc.

### `lib/shield/db.js`

Base de données SQLite pour le cache des utilisateurs du Guild Enforcer. Gère la persistance des utilisateurs avec triggers pour synchroniser avec le système en mémoire.

#### Méthodes publiques

- **`get(id)`** — Récupère un utilisateur par son ID.
- **`save(id, data)`** — Sauvegarde ou met à jour un utilisateur.
- **`delete(id)`** — Supprime un utilisateur.
- **`deleteAll()`** — Supprime tous les utilisateurs (nettoyage).

### `lib/ripley/cryo.js`

Backend Cryo pour le système Ripley. Gère la persistance des actions via le service Cryo avec support pour la synchronisation et le replay.

#### Méthodes publiques

- **`ripley(db, dispatch)`** — Rejoue les actions depuis Cryo.
- **`persist(action, rules)`** — Persiste une action selon les règles définies.
- **`hasMode(mode)`** — Vérifie si un mode de persistance est supporté.
- **`ellen(state, action)`** — Reducer pour l'état Ellen (persistance).

### `lib/test.js`

Point d'entrée pour les tests. Configure l'environnement de test et exporte le module principal.

---

_Ce document a été mis à jour pour refléter l'état actuel du code source._

[xcraft-core-bus]: https://github.com/Xcraft-Inc/xcraft-core-bus
[xcraft-core-cryo]: https://github.com/Xcraft-Inc/xcraft-core-cryo
[goblin-warehouse]: https://github.com/Xcraft-Inc/goblin-warehouse
[xcraft-core-shredder]: https://github.com/Xcraft-Inc/xcraft-core-shredder
[goblin-laboratory]: https://github.com/Xcraft-Inc/goblin-laboratory