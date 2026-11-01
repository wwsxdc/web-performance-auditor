/**
 * Structural anchor for a highlighted element (FR-14).
 *
 * A CSS selector alone cannot tell "the same node was moved" from "a different
 * node now matches the selector". The anchor records the node identity, its
 * parent and its positional neighbours at highlight time so the overlay can
 * report the target as changed instead of silently highlighting a new node.
 */
export interface TargetAnchor {
  tagName: string;
  parent: Node | null;
  previousSibling: Node | null;
  nextSibling: Node | null;
  index: number;
  selector?: string;
}

function childIndex(node: Node): number {
  const parent = node.parentNode;
  if (!parent) return -1;
  return Array.prototype.indexOf.call(parent.childNodes, node);
}

export function captureTargetAnchor(element: Element, selector?: string): TargetAnchor {
  return {
    tagName: element.tagName,
    parent: element.parentNode,
    previousSibling: element.previousSibling,
    nextSibling: element.nextSibling,
    index: childIndex(element),
    selector: selector || undefined,
  };
}

/**
 * Returns false when the element is detached, replaced, or moved to another
 * position in the DOM (FR-14). When the element is still connected but the
 * stored selector now resolves to a different node, the anchor is stale too.
 */
export function isTargetAnchorIntact(
  element: Element,
  anchor: TargetAnchor,
  resolveSelector: (selector: string) => Element | null,
): boolean {
  if (!element.isConnected) return false;
  if (element.tagName !== anchor.tagName) return false;
  if (element.parentNode !== anchor.parent) return false;
  if (childIndex(element) !== anchor.index) return false;
  if (element.previousSibling !== anchor.previousSibling) return false;
  if (element.nextSibling !== anchor.nextSibling) return false;

  if (anchor.selector) {
    let resolved: Element | null = null;
    try {
      resolved = resolveSelector(anchor.selector);
    } catch {
      resolved = null;
    }
    if (resolved !== element) return false;
  }

  return true;
}
