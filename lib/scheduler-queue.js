'use strict';

const watt = require('gigawatts');
const EventEmitter = require('events');
const {locks} = require('xcraft-core-utils');

class SchedulerQueue extends EventEmitter {
  constructor() {
    super();

    this._parallelList = new Set();
    this._serieList = new Set();
    this._immediateList = new Set();
    this._mutex = new locks.Mutex();
    this._paused = true;

    this._parallel = this._parallel.bind(this);
    this._immediate = this._immediate.bind(this);
    this._error = this._error.bind(this);

    this.on('parallel', this._parallel);
    this.on('serie', (...args) => this._serie(...args));
    this.on('immediate', this._immediate);

    watt.wrapAll(this, '_serie', 'done');
  }

  _error(err) {
    if (err) {
      this.emit('error', err);
    }
  }

  _parallel(item) {
    if (this._paused) {
      this._parallelList.add(item);
    } else {
      this.emit('call', 'parallel', item, this._error);
    }
  }

  *_serie(item, next) {
    yield this._mutex.lock();
    try {
      if (this._paused) {
        this._serieList.add(item);
      } else {
        yield this.emit('call', 'serie', item, next);
      }
    } catch (ex) {
      this._error(ex);
    } finally {
      this._mutex.unlock();
    }
  }

  _immediate(item) {
    this.emit('call', 'immediate', item, this._error);
  }

  get paused() {
    return this._paused;
  }

  *done(next) {
    try {
      this._paused = false;

      for (const item of this._parallelList) {
        this.emit('call', 'parallel', item, next);
      }
      this._parallelList.clear();

      for (const item of this._serieList) {
        yield this.emit('call', 'serie', item, next);
      }
      this._serieList.clear();
    } catch (ex) {
      this._error(ex);
    }
  }
}

module.exports = SchedulerQueue;
