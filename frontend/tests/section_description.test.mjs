import assert from 'node:assert/strict';
import test from 'node:test';
import { controls } from './native-controls-harness.mjs';
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, predicate);
    if (result) return result;
  }
};
const text = (tree) =>
  find(
    tree,
    (node) =>
      node.type === 'text' &&
      node.props?.className?.split(' ').includes('section-description'),
  );
const toggle = (tree) =>
  find(tree, (node) => node.props?.className === 'section-description-toggle');
const props = {
  title: 'URL 播放',
  description:
    '将音频 URL 推送到当前选中的设备或设备分组。URL 必须能从音箱所在网络访问。',
};
const layout = (tree, lines) =>
  find(tree, (node) =>
    node.props?.className?.includes('section-description-measure'),
  ).props.bindlayoutchange({ detail: { height: lines * 18, width: 280 } });
test('fully visible descriptions have no expansion control even above forty characters', () => {
  assert.ok(props.description.length > 40);
  const h = controls({ compactSettings: true });
  let tree = h.render('SectionCard', props);
  assert.equal(toggle(tree), undefined);
  layout(tree, 2);
  tree = h.render('SectionCard', props);
  assert.equal(toggle(tree), undefined);
  assert.equal(text(tree).props['text-maxline'], undefined);
});
test('actual overflow remains foldable through clamp, expand, collapse and width changes', () => {
  const h = controls({ compactSettings: true });
  let tree = h.render('SectionCard', props);
  layout(tree, 3);
  tree = h.render('SectionCard', props);
  assert.equal(text(tree).props['text-maxline'], '2');
  assert.equal(toggle(tree).props.label, '展开说明');
  layout(tree, 3);
  tree = h.render('SectionCard', props);
  assert.ok(toggle(tree));
  toggle(tree).props.onClick();
  tree = h.render('SectionCard', props);
  layout(tree, 3);
  tree = h.render('SectionCard', props);
  assert.equal(text(tree).props['text-maxline'], undefined);
  assert.equal(toggle(tree).props.label, '收起说明');
  toggle(tree).props.onClick();
  tree = h.render('SectionCard', props);
  assert.equal(text(tree).props['text-maxline'], '2');
  layout(tree, 2);
  tree = h.render('SectionCard', props);
  assert.equal(toggle(tree), undefined);
  layout(tree, 4);
  tree = h.render('SectionCard', props);
  assert.equal(toggle(tree).props.label, '展开说明');
});
test('short content replacing a long explanation does not inherit its folding state', () => {
  const h = controls({ compactSettings: true });
  let tree = h.render('SectionCard', props);
  layout(tree, 3);
  tree = h.render('SectionCard', { ...props, description: '音频 URL' });
  assert.equal(toggle(tree), undefined);
  layout(tree, 1);
  tree = h.render('SectionCard', { ...props, description: '音频 URL' });
  assert.equal(toggle(tree), undefined);
});
