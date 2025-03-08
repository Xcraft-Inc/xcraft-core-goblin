'use strict';

const {expect} = require('chai');

describe('xcraft.goblin.elf.ripley', function () {
  const {computeRipleySteps} = require('../lib/ripleyHelpers.js');

  const persisted8 = [
    {data: {commitId: 'A'}},
    {data: {commitId: 'B'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'E'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'G'}},
  ];

  const commitCnt8 = {
    A: 1,
    B: 1,
    D: 3,
    E: 1,
    F: 1,
    G: 1,
  };

  it('computeSteps 8 (old server)', function () {
    const steps = computeRipleySteps(persisted8, undefined, 4);
    expect(steps).to.be.eql([8]);
  });

  it('computeSteps 8 (new server, limit 1)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 1);
    expect(steps).to.be.eql([1, 1, 3, 1, 1, 1]);
  });

  it('computeSteps 8 (new server, limit 2)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 2);
    expect(steps).to.be.eql([2, 3, 2, 1]);
  });

  it('computeSteps 8 (new server, limit 4)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 4);
    expect(steps).to.be.eql([2, 4, 2]);
  });

  it('computeSteps 8 (new server, limit 6)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 6);
    expect(steps).to.be.eql([6, 2]);
  });

  it('computeSteps 8 (new server, limit 10)', function () {
    const steps = computeRipleySteps(persisted8, commitCnt8, 10);
    expect(steps).to.be.eql([8]);
  });

  const persisted22 = [
    {data: {commitId: 'A'}},
    {data: {commitId: 'A'}},
    {data: {commitId: 'B'}},
    {data: {commitId: 'C'}},
    {data: {commitId: 'C'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'D'}},
    {data: {commitId: 'E'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'F'}},
    {data: {commitId: 'G'}},
    {data: {commitId: 'G'}},
    {data: {commitId: 'G'}},
    {data: {commitId: 'H'}},
    {data: {commitId: 'I'}},
    {data: {commitId: 'I'}},
    {data: {commitId: 'I'}},
  ];

  const commitCnt22 = {
    A: 2,
    B: 1,
    C: 2,
    D: 3,
    E: 1,
    F: 6,
    G: 3,
    H: 1,
    I: 3,
  };

  it('computeSteps 22 (old server)', function () {
    const steps = computeRipleySteps(persisted22, undefined, 4);
    expect(steps).to.be.eql([22]);
  });

  it('computeSteps 22 (new server, limit 1)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 1);
    expect(steps).to.be.eql([2, 1, 2, 3, 1, 6, 3, 1, 3]);
  });

  it('computeSteps 22 (new server, limit 2)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 2);
    expect(steps).to.be.eql([2, 1, 2, 3, 1, 6, 3, 1, 3]);
  });

  it('computeSteps 22 (new server, limit 4)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 4);
    expect(steps).to.be.eql([3, 2, 4, 6, 4, 3]);
  });

  it('computeSteps 22 (new server, limit 6)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 6);
    expect(steps).to.be.eql([5, 4, 6, 4, 3]);
  });

  it('computeSteps 22 (new server, limit 10)', function () {
    const steps = computeRipleySteps(persisted22, commitCnt22, 10);
    expect(steps).to.be.eql([9, 10, 3]);
  });
});
