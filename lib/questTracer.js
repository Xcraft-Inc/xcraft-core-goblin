const buildLink = (source, target) => ({
  data: {id: source + '->' + target, source, target, label: 'call'},
});

const buildNode = (id, label) => {
  return {
    data: {id, label, position: {x: 1, y: 1}},
  };
};

//public graph
const graph = [];

//cache
const nodes = {};
const links = {};
const exludes = ['warehouse', 'goblin', 'workshop'];
module.exports = {
  trace: (fromNamespace, toNamespace) => {
    //skip some nodes
    if (exludes.includes(toNamespace) || exludes.includes(fromNamespace)) {
      return;
    }

    if (!nodes[fromNamespace]) {
      nodes[fromNamespace] = fromNamespace;
      graph.push(buildNode(fromNamespace, fromNamespace));
    }
    if (!nodes[toNamespace]) {
      nodes[toNamespace] = toNamespace;
      graph.push(buildNode(toNamespace, toNamespace));
    }
    const link = buildLink(fromNamespace, toNamespace);
    if (!links[link.data.id]) {
      links[link.data.id] = link.data.id;
      graph.push(link);
    }
  },
  graph,
};
