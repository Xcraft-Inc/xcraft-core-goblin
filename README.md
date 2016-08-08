# xcraft-core-goblin
Xcraft uService API

# Welcome on board!

>Goblins are small, green (or yellow-green) creatures with pointy features and high intelligence (though often little common sense). Goblins speak Goblin, Orcish, and Common. Goblins know myriad languages in order to trade with as many races as possible.

With goblin you can craft some redux uService on top of the Orcish Xcraft toolchain infrastructure.

This package provide a thin API and conventions for building your first goblin.

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

and a `my-namespace.js` file for registering your namespace and quests on the Xcraft server:

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
    if (!isNaN (Number (action.amount))) {
      state.gold += Number (action.amount);
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
  // we dispatch with quest an internal action called cashin  
  quest.dispatch ({type: 'cashin', amount: msg.data.amount});

  // we finish the quest
  yield quest.next ();
});

// We must exporting quests
module.exports = goblin.quests;
```
