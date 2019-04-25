'use strict';

const watt = require('gigawatts');
const {expect} = require('chai');
const SchedulerQueue = require('../lib/scheduler-queue.js');

describe('scheduler-queue', function() {
  it(
    'serie',
    watt(function*(next) {
      let acc = 0;
      let cnt = 0;
      const queue = new SchedulerQueue();

      queue.on('call', (type, item, next) => {
        if (type === 'serie') {
          ++cnt;
          acc += item;
          setTimeout(() => {
            if (cnt === 1) {
              expect(acc).to.be.equal(3);
            } else if (cnt === 2) {
              expect(acc).to.be.equal(5);
            } else if (cnt === 3) {
              expect(acc).to.be.equal(6);
            }
            next();
          }, 10 * item);
        }
      });

      yield queue.done();

      queue.emit('serie', 3, next.parallel()); // 30ms
      queue.emit('serie', 2, next.parallel()); // 20ms
      queue.emit('serie', 1, next.parallel()); // 10ms

      yield next.sync();

      expect(acc).to.be.equal(6);
    })
  );

  it(
    'parallel',
    watt(function*(next) {
      let acc = 0;
      let cnt = 0;
      const queue = new SchedulerQueue();

      yield queue.done();

      queue.on('call', (type, item) => {
        if (type === 'parallel') {
          ++cnt;
          acc += item;
          setTimeout(() => {
            if (cnt === 1) {
              expect(acc).to.be.equal(1);
            } else if (cnt === 2) {
              expect(acc).to.be.equal(3);
            } else if (cnt === 3) {
              expect(acc).to.be.equal(6);
              next();
            }
          }, 10 * item);
        }
      });

      queue.emit('parallel', 3); // 30ms
      queue.emit('parallel', 2); // 20ms
      queue.emit('parallel', 1); // 10ms

      yield;

      expect(acc).to.be.equal(6);
    })
  );

  it('immediate', function(done) {
    let acc = 0;
    const queue = new SchedulerQueue();

    // The first message must be 'immediate'
    queue.once('call', (type, item) => {
      expect(type).to.be.equal('immediate');
      expect(item).to.be.equal(1);
    });

    queue.on('call', (type, item) => {
      if (type === 'immediate') {
        queue.done();
      } else if (type === 'parallel') {
        acc += item;
        if (acc === 1 + 2 + 3) {
          done();
        }
      }
    });

    queue.emit('parallel', 1);
    queue.emit('parallel', 2);
    queue.emit('parallel', 3);

    queue.emit('immediate', 1);
  });
});
