
# xcraft-core-goblin

Xcraft uService API

# Welcome on board!

>Goblins are small, green (or yellow-green) creatures with pointy features and high intelligence (though often little common sense). Goblins speak Goblin, Orcish, and Common. Goblins know myriad languages in order to trade with as many races as possible.

With goblin you can craft some redux uService on top of the Orcish Xcraft toolchain infrastructure.

This package provide a thin API and conventions for building your first goblin.

# Goblins

>When you implement a goblin, you must think like a goblin. 

## Goblin instances

By default goblins are instantiated by a create command:  `const extractor = yield quest.create ('gold-extractor', payload)`

When an instance is created in a quest, your goblin must control the deletion of this goblin.

Fortunatly we have a simple `defer ()` method available on quest and goblin.

### The quest.create (namespace, args) command

Under the hood, `quest.create` send a `quest.cmd ('gold-extractor.create', {...payload})` and return a object containing id and all wrapped public quests.


### Single instance

Some goblins can be created as singleton. In the case `quest.create` will not work. You must send a command to the goblin directly with `quest.cmd`.


### Deleting goblins instances with defer ()

Just after creating a instance with `quest.create` you can register a defer call for deleting the instance at the right moment.

#### quest lifetime scope

We use `quest.defer()` for regisering a func to be run when the current quest finish

```js
// Example of use for defering when we leave the quest
goblin.registerQuest ('test', (quest, msg) => {

  const extractor = yield quest.create ('gold-extractor');
  // We defer the delete quest, after this quest
  quest.defer (extractor.delete);
  const gold = extractor.extract ('http://mineofgold.com');
  ...
});
```

#### goblin lifetime scope

We use `quest.goblin.defer()` for registering a func to be run after the delete quest of our instance was run

```js
// Example of use for defering when we leave delete this instance
goblin.registerQuest ('create', (quest, msg) => {

  const extractor = yield quest.create ('gold-extractor');
  // We defer the delete quest, after our goblin delete quest run
  quest.goblin.defer (extractor.delete);
  const gold = extractor.extract ('http://mineofgold.com');
  ...
});
```

# Quests

A quest is a powerfull running context for dealing with other goblins. You can create goblins via commands, sending events for signaling some status, waiting for other goblins events and dispatch actions for modifing your state.

From another point of view, quests are providing lifetime handlers for a goblin instance,
the creation of a goblin instance is always handled by the `create` quest and the `delete` quest provide the deletion impl. of an instance.

Other quests, are like methods of an instance, `add`, `remove`, `open`, `close` etc...


## Quest handlers

```js

// Exemple of a create quest
goblin.registerQuest ('create', (quest, id, somedata) => {

  quest.dispatch ('mutate', {somedata});

  // dispatch ('create' with automatic payload:
  quest.do ();

  // logging
  quest.log.info ('Subscription done!');

  // cmd sending
  yield quest.cmd ('somegoblin.somequest', {
    someparam: 'value',
  });

  // evt sending
  // the final topic is prefixed with your goblin name
  quest.evt ('bim.bam.boom', {some: payload});

  // (sub|unsub) scribe to evt's
  // full topic name is required
  const unsub = quest.sub ('somegoblin.topic', handler => yo);
  unsub ();

  // wait on an event
  yield quest.sub.wait ('somegoblin.topic');
});
```

# Goblin state persitence "feat. Ellen Riplay"

```js
const persistenceConfig = {
  DISPATCH_TYPENAME_TO_REPLAY: {
    mode: 'all'
  },
  ANOTHER_TYPENAME_TO_REPLAY: {
    mode: 'last'
  },
  YA_TYPE_BYKEY: {
    mode: 'allbykeys',
    keys: ['key1']
  }
}

// Give the persistence config at last arg.
const goblin = new Goblin (goblinName, logicState, logicHandlers, persistenceConfig);
```

# Goblin Shredder

Mutate your state with de Super Reaper 6000 mega shredder!

```js
const logicState = new Goblin.Shredder ({
  gold: 0
});

const logicHandlers = {
  cashin: (state, action) => {

    state = state.set ('collection.key', {bid: ['ule','oche']});
    if (state.includes ('collection.key[0]', 10)) {
      const key = state.get (`collection.key.bid[0]`, 2);
      state = state.set ('collection.lol', key);
      state = state.del ('collection.lol');
    }

    return state;
  }

const goblin = new Goblin (goblinName, logicState, logicHandlers);


```



# Your first goblin

## Part 1: providing quest

Create a folder named `goblin-treasure` with two files:

A `rc.json` file for describing your quest:

```json
{
  "cashin": {
    "desc": "Add cash to your treasure!",
    "options": {
      "params": {
        "required": "amount"
      }
    }
  }
}
```

and a `treasure.js` file for registering your namespace and quests on the Xcraft server:

```js
'use strict';

const path    = require ('path');
const service = require ('./lib/service.js');

/**
 * Retrieve the list of available commands.
 *
 * @returns {Object} The list and definitions of commands.
 */
exports.xcraftCommands = function () {
  const xUtils = require ('xcraft-core-utils');
  return {
    handlers: service,
    rc: xUtils.json.fromFile (path.join (__dirname, './rc.json'))
  };
};
```

You must now implement the quest in `lib/service.js`

## Part 2: quest implementation with goblin

Create a file in a `lib` subfolder named `service.js`.

Extract the namespace and require the Goblin:

```js
'use strict';

const path = require ('path');
const goblinName = path.basename (module.parent.filename, '.js');

const Goblin = require ('xcraft-core-goblin');

```

Define the initial state of the goblin:
```js
// Define initial logic values
const logicState = {
  gold: 0
};
```

Define the logic behind the `cashin` quest:
```js
// Define logic handlers according rc.json
const logicHandlers = {
  cashin: (state, action) => {
    if (!isNaN (Number (action.meta.amount))) {
      state.gold += Number (action.meta.amount);
      state.valid = true;
    } else {
      state.valid = false;
    }
    return state;
  }
};
```

And finally create a goblin:
```js
// Create a Goblin with initial state and handlers
const goblin = new Goblin (goblinName, logicState, logicHandlers);

// Register quest's according rc.json
goblin.registerQuest ('cashin', function * (quest, msg) {
  quest.do ();
});

// We must exporting quests
module.exports = goblin.quests;
```
