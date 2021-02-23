'use strict';

const moduleName = 'scheduler';

const EventEmitter = require('events');
const watt = require('gigawatts');
const $ = require('highland');
const SchedulerQueue = require('./scheduler-queue.js');
const xLog = require('xcraft-core-log')(moduleName, null);

class Scheduler {
  constructor(goblinName, dispatch, isSingleton) {
    this._goblinName = goblinName;
    this._dp = dispatch;
    this._queue = new SchedulerQueue();

    this.questEmitter = new EventEmitter();

    this._queue
      .on('error', (err) => xLog.err(err.stack || err))
      .on('call', (type, item, next) => {
        const {goblin, questName, quest, dispatch, done, doneId} = item;
        switch (type) {
          case 'serie':
          case 'parallel':
            this._dp(goblin, questName, quest, dispatch, done, doneId, next);
            break;

          case 'immediate': {
            const _done = (...args) => {
              if (questName === 'create' && this._queue.paused) {
                this._queue.resume();
              }
              done(...args);
            };
            this._dp(goblin, questName, quest, dispatch, _done, doneId, next);
            break;
          }
        }
      });

    // Singleton? enable runners
    if (isSingleton) {
      this._queue.resume();
    }

    this._promises = {};
    this._inDeleteState = false;

    this._dispatchQuestRunner = $('dispatch-quest', this.questEmitter)
      .map((payload) => (next) => this._dispatchQuest(payload, next))
      .nfcall([])
      .sequence()
      .stopOnError((err) => xLog.warn(err.stack || err));

    this._dispatchQuestRunner.done();

    watt.wrapAll(this, '_dispatchQuest');
  }

  get infos() {
    return {
      queue: this._queue.infos,
    };
  }

  dispose() {
    this.questEmitter.removeAllListeners();
    this._queue.removeAllListeners();
  }

  _nextParallel(call) {
    const id = Symbol();
    const promise = new Promise((resolve) => call(resolve, id));
    this._promises[id] = promise;
    promise.then((id) => {
      delete this._promises[id];
    });
  }

  *_dispatchQuest(
    {goblin, questName, quest, dispatch, cmdMode, msg, resp},
    next
  ) {
    const emit = this._queue.emit.bind(this._queue);

    if (this._inDeleteState) {
      xLog.warn(`${questName} running when a delete as started`);
    }

    switch (cmdMode) {
      case 'delete': {
        const generation = goblin._generationId;

        if (Object.keys(this._promises).length) {
          for (const id in this._promises) {
            yield this._promises[id];
          }
        }

        if (msg.data.generation) {
          if (msg.data.generation > generation) {
            throw new Error(
              `generation received is newer than generation in goblin instance: ${goblin.id}`
            );
          }

          if (msg.data.generation < generation) {
            resp.events.send(`${this._goblinName}.delete.${msg.id}.finished`);
            return;
          }
        } else {
          //FIXME: current bug
          console.warn(`${goblin.id} can not be deleted without generation`);
          resp.events.send(`${this._goblinName}.delete.${msg.id}.finished`);
          return;
        }

        this._inDeleteState = true;

        yield this._dp(goblin, questName, quest, dispatch, null, null, next);

        yield resp.command.nestedSend(
          `warehouse.acknowledge`,
          {
            branch: goblin.id,
            generation: msg.data.generation,
          },
          next
        );

        this._inDeleteState = false;
        break;
      }

      case 'create':
        /* create commands and commands called from create */
        this._nextParallel((done, doneId) =>
          emit('immediate', {goblin, questName, quest, dispatch, done, doneId})
        );
        break;

      case 'serie':
        this._nextParallel((done, doneId) =>
          emit('serie', {goblin, questName, quest, dispatch, done, doneId})
        );
        break;

      case 'parallel':
        this._nextParallel((done, doneId) =>
          emit('parallel', {goblin, questName, quest, dispatch, done, doneId})
        );
        break;
    }
  }
}

const schedulerEmitter = new EventEmitter();
const createQuests = ['create'];

schedulerEmitter.on('quest', (quest) => {
  quest.cmdMode = null;

  if (quest.questName === 'delete') {
    quest.cmdMode = 'delete';
    quest.goblin.questEmitter.emit('dispatch-quest', quest);
    return;
  }

  if (quest.caller === undefined) {
    quest.cmdMode = 'parallel';
    quest.goblin.questEmitter.emit('dispatch-quest', quest);
    return;
  }

  /* Compute the equation for detecting when the command mode is "create"
   * instead of "parallel". The "create" command mode ensures that it's not
   * possible to use the goblin instance while it's not fully created.
   * There are exceptions when quests are sent from a "create" quest and this
   * is the purpose of the following truth table.
   *
   * Where A = inCreateQuest / when we are in a "create" quest
   *       B = quest.goblin.isCreating() / a "create" quest is already running
   *       C = quest.isInCreate / when the caller is in a "create" quest
   *       D = selfCall / when we call a quest on our own goblin
   *
   * Truth table                 Karnaugh
   * ┌───┬───┬───┬───╥───╖       ┌──────┬─────────────────┐
   * │ A │ B │ C │ D ║ S ║       │   AB │ 00  01  11  10  │
   * ├───┼───┼───┼───╫───╢       │ CD   │                 │
   * │ 0 │ 0 │ 0 │ 0 ║ 0 ║       ├──────┼─────────────────┤
   * │ 0 │ 0 │ 0 │ 1 ║ 0 ║       │      │        ┌───┐    │
   * │ 0 │ 0 │ 1 │ 0 ║ 0 ║       │ 00   │  0   0 │ 1 │ 0  │ AB
   * │ 0 │ 0 │ 1 │ 1 ║ x ║       │      │    ┌───╔═══╤═══╗│
   * │ 0 │ 1 │ 0 │ 0 ║ 0 ║       │ 01   │  0 │ x ║ x │ 1 ║│ BD, AD
   * │ 0 │ 1 │ 0 │ 1 ║ x ║       │      │    │   ╟───────╢│
   * │ 0 │ 1 │ 1 │ 0 ║ 0 ║       │ 11   │  x │ 1 ║ 1 │ x ║│ AC
   * │ 0 │ 1 │ 1 │ 1 ║ 1 ║       │      │    └───╚═══╧═══╝│
   * │ 1 │ 0 │ 0 │ 0 ║ 0 ║       │ 10   │  0   0 │ 1 │ 1 ││
   * │ 1 │ 0 │ 0 │ 1 ║ 1 ║       │      │        └───────┘│
   * │ 1 │ 0 │ 1 │ 0 ║ 1 ║       └──────┴─────────────────┘
   * │ 1 │ 0 │ 1 │ 1 ║ x ║       S = BD + AD + AB + AC
   * │ 1 │ 1 │ 0 │ 0 ║ 1 ║
   * │ 1 │ 1 │ 0 │ 1 ║ x ║
   * │ 1 │ 1 │ 1 │ 0 ║ 1 ║
   * │ 1 │ 1 │ 1 │ 1 ║ 1 ║
   * └───┴───┴───┴───╨───╜
   */

  const selfCall = quest.caller === quest.goblin.id;
  const inCreateQuest = createQuests.includes(quest.questName);
  if (
    (quest.goblin.isCreating() && selfCall) ||
    (inCreateQuest && selfCall) ||
    (inCreateQuest && quest.goblin.isCreating()) ||
    (inCreateQuest && quest.isInCreate)
  ) {
    quest.cmdMode = 'create';
  } else {
    quest.cmdMode = 'parallel';
  }

  quest.goblin.questEmitter.emit('dispatch-quest', quest);
});

module.exports = Scheduler;
module.exports.dispatch = schedulerEmitter.emit.bind(schedulerEmitter);
