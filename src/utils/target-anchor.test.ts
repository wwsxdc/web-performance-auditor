import { describe, expect, it } from 'vitest';
import {
  captureTargetAnchor,
  isTargetAnchorIntact,
  type TargetAnchor,
} from './target-anchor';

interface FakeParent {
  childNodes: unknown[];
}

interface FakeElement {
  tagName: string;
  isConnected: boolean;
  parentNode: FakeParent;
  previousSibling: unknown;
  nextSibling: unknown;
}

function makeParent(): FakeParent {
  return { childNodes: [] };
}

function makeElement(
  parent: FakeParent,
  index: number,
  options: { tagName?: string; connected?: boolean } = {},
): FakeElement {
  const childNodes = parent.childNodes;
  const element: FakeElement = {
    tagName: options.tagName ?? 'DIV',
    isConnected: options.connected ?? true,
    parentNode: parent,
    previousSibling: childNodes[index - 1] ?? null,
    nextSibling: childNodes[index + 1] ?? null,
  };
  childNodes[index] = element;
  // Keep the neighbours' pointers in sync with the new child.
  const previous = childNodes[index - 1] as { nextSibling?: unknown } | undefined;
  if (previous) previous.nextSibling = element;
  const next = childNodes[index + 1] as { previousSibling?: unknown } | undefined;
  if (next) next.previousSibling = element;
  return element;
}

const noSelector = () => null;

describe('target anchor', () => {
  it('stays intact while the node keeps its parent and position', () => {
    const parent = makeParent();
    const element = makeElement(parent, 0);
    makeElement(parent, 1);
    const anchor = captureTargetAnchor(element as unknown as Element);

    expect(isTargetAnchorIntact(element as unknown as Element, anchor, noSelector)).toBe(true);
  });

  it('is stale once the node is detached', () => {
    const parent = makeParent();
    const element = makeElement(parent, 0);
    const anchor = captureTargetAnchor(element as unknown as Element);
    element.isConnected = false;

    expect(isTargetAnchorIntact(element as unknown as Element, anchor, noSelector)).toBe(false);
  });

  it('is stale when the selector resolves to a different node', () => {
    const parent = makeParent();
    const element = makeElement(parent, 0);
    const replacement = {};
    const anchor: TargetAnchor = captureTargetAnchor(element as unknown as Element, '#hero');

    expect(isTargetAnchorIntact(element as unknown as Element, anchor, () => element as unknown as Element)).toBe(true);
    expect(
      isTargetAnchorIntact(element as unknown as Element, anchor, () => replacement as unknown as Element),
    ).toBe(false);
  });

  it('is stale when the node is moved to another parent', () => {
    const parent = makeParent();
    const element = makeElement(parent, 0);
    const anchor = captureTargetAnchor(element as unknown as Element);
    const otherParent = makeParent();
    otherParent.childNodes[0] = element;
    element.parentNode = otherParent;

    expect(isTargetAnchorIntact(element as unknown as Element, anchor, noSelector)).toBe(false);
  });

  it('is stale when a sibling is inserted before the node', () => {
    const parent = makeParent();
    makeElement(parent, 0);
    const element = makeElement(parent, 1);
    const anchor = captureTargetAnchor(element as unknown as Element);

    parent.childNodes.splice(0, 0, {});

    expect(isTargetAnchorIntact(element as unknown as Element, anchor, noSelector)).toBe(false);
  });

  it('is stale when the adjacent sibling is replaced in place', () => {
    const parent = makeParent();
    const element = makeElement(parent, 0);
    makeElement(parent, 1);
    const anchor = captureTargetAnchor(element as unknown as Element);
    parent.childNodes[1] = { previousSibling: element };
    element.nextSibling = parent.childNodes[1];

    expect(isTargetAnchorIntact(element as unknown as Element, anchor, noSelector)).toBe(false);
  });

  it('treats a throwing selector as stale', () => {
    const parent = makeParent();
    const element = makeElement(parent, 0);
    const anchor = captureTargetAnchor(element as unknown as Element, '::invalid');

    expect(
      isTargetAnchorIntact(element as unknown as Element, anchor, () => {
        throw new Error('invalid selector');
      }),
    ).toBe(false);
  });
});
