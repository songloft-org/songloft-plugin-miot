// Small bounded XML reader for SOAP/DIDL. DTDs and external entities are rejected.
export interface XMLNode {
  name: string;
  local: string;
  attrs: Record<string, string>;
  children: XMLNode[];
  text: string;
}

export function escapeXML(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function decodeXML(value: string): string {
  return value.replace(/&([^;\s]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.prototype.hasOwnProperty.call(named, entity)) return named[entity];
    if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) {
      const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n);
    }
    throw new Error('Invalid XML entity');
  });
}

export function parseXML(xml: string): XMLNode {
  if (xml.length > 65536 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML too large or contains DTD');
  const root: XMLNode = { name: '', local: '', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g) || [];
  if (tokens.join('') !== xml) throw new Error('Invalid XML');
  let nodes = 0;
  for (const token of tokens) {
    const current = stack[stack.length - 1];
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { current.text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) {
      if (stack.length < 2 || token !== `</${current.name}>`) throw new Error('Mismatched XML tag');
      stack.pop();
    } else if (token.startsWith('<')) {
      const match = token.match(/^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/);
      if (!match || ++nodes > 1024 || stack.length > 16) throw new Error('Invalid XML tag or nesting');
      const attrs: Record<string, string> = Object.create(null);
      const remaining = match[2].replace(/\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, key, a, b) => {
        if (key in attrs) throw new Error('Duplicate XML attribute');
        attrs[key] = decodeXML(a ?? b);
        return '';
      });
      if (remaining.trim()) throw new Error('Invalid XML attribute');
      const node: XMLNode = { name: match[1], local: match[1].split(':').pop()!, attrs, children: [], text: '' };
      current.children.push(node);
      if (!match[3]) stack.push(node);
    } else {
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(token)) throw new Error('Invalid XML entity');
      current.text += decodeXML(token);
    }
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.text.trim()) throw new Error('Incomplete XML');
  return root.children[0];
}

export function child(node: XMLNode, local: string): XMLNode | undefined {
  return node.children.find(n => n.local === local);
}

export function xmlResponse(body: string, statusCode = 200) {
  return { statusCode, headers: { 'Content-Type': 'text/xml; charset="utf-8"' }, body: `<?xml version="1.0" encoding="utf-8"?>${body}` };
}
