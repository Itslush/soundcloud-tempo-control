const assert = require('node:assert/strict');
const { parsers } = require('prettier/plugins/babel');

module.exports = function artifactConstants(source, names) {
  const found = new Map(names.map((name) => [name, []]));
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && found.has(node.id?.name))
      found.get(node.id.name).push(node.init?.value);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'tokens', 'comments'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parsers.babel.parse(source).program);
  return Object.fromEntries(
    [...found].map(([name, values]) => {
      assert.equal(
        values.length,
        1,
        `Expected exactly one ${name} declaration`,
      );
      assert.notEqual(values[0], undefined, `${name} must be a literal`);
      return [name, values[0]];
    }),
  );
};

if (require.main === module) {
  const fs = require('node:fs');
  const source = fs.readFileSync(process.argv[2], 'utf8');
  console.log(JSON.stringify(module.exports(source, process.argv.slice(3))));
}
