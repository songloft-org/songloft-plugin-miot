import { readFileSync } from 'node:fs';
import ts from 'typescript';
/** Read the migrated component's domain setup for focused race regression tests. */
export function readSetup(name) {
  const url = new URL(
    '../src/' + name.replace(/\.vue$/, '.tsx'),
    import.meta.url,
  );
  const text = readFileSync(url, 'utf8');
  const source = ts.createSourceFile(
    url.pathname,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let setup;
  function visit(node) {
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(source) === 'createState'
    )
      setup = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!setup) throw new Error('setup missing: ' + name);
  const imports = source.statements
    .filter(
      (node) =>
        ts.isImportDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        (ts.isVariableStatement(node) &&
          !node.getText(source).startsWith('const pageState')),
    )
    .map((node) => node.getText(source))
    .join('\n');
  const body = setup.body.statements
    .filter((node) => {
      const code = node.getText(source);
      return (
        !ts.isReturnStatement(node) &&
        !code.startsWith('__expose(') &&
        !code.startsWith('const bindings') &&
        !code.startsWith('const __returned__') &&
        !code.startsWith('Object.defineProperty') &&
        !code.startsWith('return __returned__')
      );
    })
    .map((node) => node.getText(source))
    .join('\n');
  return imports + '\n' + body;
}
