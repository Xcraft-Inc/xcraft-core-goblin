# xcraft-core-goblin

Xcraft uService API

# Welcome on board!

> Goblins are small, green (or yellow-green) creatures with pointy features and
> high intelligence (though often little common sense). Goblins speak Goblin,
> Orcish, and Common. Goblins know myriad languages in order to trade with as
> many races as possible.

With goblin you can craft some redux uService on top of the Orcish Xcraft
toolchain infrastructure.

This package provide a thin API and conventions for building your first goblin.

# Goblins

> When you implement a goblin, you must think like a goblin.

## Goblin instances

By default, the goblins are instantiated by a create command:
`const extractor = yield quest.create ('gold-extractor', payload)`

When an instance is created this way in a goblin quest,
you own the created instance, and some rules apply:

When your gobelin (the owner) is deleted, sub-creations is also automagically
deleted with a call to the delete quest.

### The `quest.create (namespace, args)` command

Under the hood, `quest.create` sends a`quest.cmd ('gold-extractor.create', {...payload})`
and returns an object containing `id` and all wrapped public quests.

### Variants

The createFor variant `quest.createFor (owner-namespace, id, namespace, args)`,
allow you to define the owner manually, so when the specified owner is deleted,
this creation will be too.

### Single instance

Some goblins can be created as singleton. In this case, `quest.create` will
not work. You must send a command to the goblin directly with `quest.cmd`.

#### quest lifetime scope

We use `quest.defer ()` for registering a function to be run when the current
quest is finished.

```js
// Example of use for defering when we leave the quest
goblin.registerQuest ('test', (quest) => {
  const extractor = yield quest.create ('gold-extractor');
  // We defer the delete quest, after this quest
  quest.defer (extractor.delete);
  const gold = extractor.extract ('http://mineofgold.com');
  /* ... */
});
```

#### goblin lifetime scope

We use `quest.goblin.defer ()` for registering a function to be run after the
quest deletion of our goblin instance.

```js
// Example of use for defering when we leave the delete of this instance
goblin.registerQuest ('create', (quest) => {
  const extractor = yield quest.create ('gold-extractor');
  // We defer the delete quest, after our goblin delete quest run
  quest.goblin.defer (extractor.delete);
  const gold = extractor.extract ('http://mineofgold.com');
  /* ... */
});
```

# Quests

A quest is a powerfull running context for dealing with other goblins. You can
create goblins, running dedicated commands, sending events for signaling some
status, waiting for other goblins events and dispatch actions for modifing
your state.

From another point of view, quests are providing lifetime handlers for a goblin
instance, the creation of a goblin instance is always handled by the `create`
quest and the `delete` quest provides the deletion implementation of an
instance.

Other quests, are like methods of an instance, `add`, `remove`, `open`,
`close` etc...

## create and delete quests

When you configure a goblin, you must register a `create` and a `delete` quest.
This is not true for a single instance (singleton) goblin.

### Widget example

We create a widget goblin named `panel`, we register and implement:

- `create` (required!)
- `delete` (required!)
- `toggle`
- `set-title`

#### usage for this example:

```js
const panel = yield quest.create ('panel');
quest.goblin.defer (panel.delete);
panel.toggle ();
panel.setTitle ({title: 'Hello World'});
```

### Single instance service example

We create a single instance goblin named `window-manager`, we register and
implement:

- `init`
- `win.create` (required!)
- `win.delete` (required!)
- `win.show`

#### usage for this example:

```js
const win = yield quest.create ('wm');
quest.goblin.defer ( quest.release(win.id));
win.show ();
```

## Quest handlers

```js
// Example of a `create` quest
goblin.registerQuest ('create', (quest, somedata) => {
  quest.dispatch ('mutate', {somedata});

  // dispatch 'create' with automatic payload:
  quest.do ();

  // logging
  quest.log.info ('done!');

  // cmd sending
  yield quest.cmd ('somegoblin.somequest', {
    someparam: 'value',
  });

  // event sending
  // the final topic is prefixed with your goblin name
  quest.evt ('bim.bam.boom', {some: payload});

  // (sub|unsub) scribe to events
  // full topic name is required
  const unsub = quest.sub ('somegoblin.topic', handler => yo);
  unsub ();

  // wait on an event
  yield quest.sub.wait ('somegoblin.topic');

  // Create widget via goblins
  const panel = yield quest.create ('panel');
  quest.goblin.defer (panel.delete);
  panel.toggle ();
  panel.setTitle ({title: 'Hello World'});
});
```

# Goblin state persistence "feat. Ellen Ripley"

```js
const ripleyConfig = {
  DISPATCH_TYPENAME_TO_REPLAY: {
    mode: 'all',
  },
  ANOTHER_TYPENAME_TO_REPLAY: {
    mode: 'last',
  },
  YA_TYPE_BYKEY: {
    mode: 'allbykeys',
    keys: ['key1'],
  },
};

// Give the ripley config at last argument
const goblin = new Goblin(goblinName, logicState, logicHandlers, ripleyConfig);
```

# Goblin Shredder

Mutate your state with de Super Reaper 6000 mega shredder!

```js
const logicState = new Goblin.Shredder({
  gold: 0,
});

const logicHandlers = {
  cashin: (state, action) => {
    state = state.set('collection.key', {bid: ['ule', 'oche']});

    if (state.includes('collection.key[0]', 10)) {
      const key = state.get(`collection.key.bid[0]`, 2);
      state = state.set('collection.lol', key);
      state = state.del('collection.lol');
    }

    return state;
  },
};

const goblin = new Goblin(goblinName, logicState, logicHandlers);
```

# Your first goblin

## Part 1: providing quest

Create a folder named `goblin-treasure` with a `treasure.js` file for
registering your namespace and quests on the Xcraft server:

```js
'use strict';

/**
 * Retrieve the list of available commands.
 *
 * @returns {Object} The list and definitions of commands.
 */
exports.xcraftCommands = function () {
  return require(`./widgets/${require('path').basename(
    __filename,
    '.js'
  )}/service.js`);
};
```

You must now implement the quest in `./widgets/treasure/service.js`.

## Part 2: quest implementation with goblin

Create a file in a `./widgets/treasure/` subfolder named `service.js`.

Extract the namespace and `require` the Goblin:

```js
'use strict';

const path = require('path');
const goblinName = path.basename(module.parent.filename, '.js');

const Goblin = require('xcraft-core-goblin');
```

Define the initial state of the goblin:

```js
// Define initial logic values
const logicState = {
  gold: 0,
};
```

Define the logic behind the `cashin` quest:

```js
// Define logic handlers according rc.json
const logicHandlers = {
  cashin: (state, action) => {
    if (!isNaN(Number(action.meta.amount))) {
      state.gold += Number(action.meta.amount);
      state.valid = true;
    } else {
      state.valid = false;
    }
    return state;
  },
};
```

And finally create a goblin:

```js
// Create a Goblin with initial state and handlers
const goblin = new Goblin(goblinName, logicState, logicHandlers);

// Register quest's according rc.json
goblin.registerQuest('cashin', function* (quest, msg) {
  quest.do();
});

// We must export the quests
module.exports = goblin.quests;
```
