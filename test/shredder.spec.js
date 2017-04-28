'use strict';

const {expect} = require ('chai');
const Shredder = require ('../lib/shredder.js');
const bimBam = {bim: 'bam'};
const grosMinet = {gros: 'minet'};

describe ('Shredder can', function () {
  it ('#set', function () {
    const s = new Shredder (bimBam);
    const n = s.set ('titi', grosMinet);

    expect (n.toJS ()).to.be.eql (
      Object.assign ({}, bimBam, {
        titi: grosMinet,
      })
    );

    expect (s.toJS ()).to.be.eql (bimBam);
  });

  it ('#set a cool path', function () {
    const s = new Shredder (bimBam);

    const n = s.set ('blim.bla.boom[1].splif[3].splaf', grosMinet);

    expect (n.toJS ()).to.be.eql ({
      bim: 'bam',
      blim: {
        bla: {
          boom: [
            undefined,
            {
              splif: [
                undefined,
                undefined,
                undefined,
                {
                  splaf: grosMinet,
                },
              ],
            },
          ],
        },
      },
    });

    expect (s.toJS ()).to.be.eql (bimBam);
  });

  it ('#del', function () {
    const s = new Shredder (bimBam);
    const n = s.del ('bim');

    expect (n.toJS ()).to.be.eql ({});
  });
});
