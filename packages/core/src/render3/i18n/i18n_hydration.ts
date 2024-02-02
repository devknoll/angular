/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {DehydratedView, I18N_ICU_DATA} from '../../hydration/interfaces';
import {locateNextRNode, siblingAfter} from '../../hydration/node_lookup_utils';
import {getNgContainerSize, processTextNodeBeforeSerialization, TextNodeMarker} from '../../hydration/utils';
import {assertDefined, assertNotEqual} from '../../util/assert';
import {I18nNode, I18nNodeKind, I18nPlaceholderType, TI18n} from '../interfaces/i18n';
import {TNode} from '../interfaces/node';
import {RNode} from '../interfaces/renderer_dom';
import {HEADER_OFFSET, HYDRATION, LView, TVIEW} from '../interfaces/view';
import {unwrapRNode} from '../util/view_utils';

/**
 * TODO: Compute the i18n data (i.e. ICU cases, if any) to serialize for the given LView.
 */
export function computeI18nSerialization(
    lView: LView, index: number,
    corruptedTextNodes: Map<HTMLElement, TextNodeMarker>): Array<number>|null {
  const tView = lView[TVIEW];
  const tI18n = tView.data[index] as TI18n | undefined;

  if (!tI18n || !tI18n.ast) {
    return null;
  }

  const cases: Array<number> = [];
  tI18n.ast.forEach(node => processForSerialization(node, lView, cases, corruptedTextNodes));
  return cases.length > 0 ? cases : null;
}


function processForSerialization(
    node: I18nNode, lView: LView, cases: Array<number>,
    corruptedTextNodes: Map<HTMLElement, TextNodeMarker>) {
  switch (node.kind) {
    case I18nNodeKind.TEXT:
      const rNode = unwrapRNode(lView[node.index]) as HTMLElement;
      processTextNodeBeforeSerialization(rNode, corruptedTextNodes);
      break;

    case I18nNodeKind.ELEMENT:
    case I18nNodeKind.PLACEHOLDER:
      node.children.forEach(
          node => processForSerialization(node, lView, cases, corruptedTextNodes));
      break;

    case I18nNodeKind.ICU:
      const currentCase = lView[node.currentCaseLViewIndex] as number;
      if (currentCase < 0) {
        const caseIdx = ~currentCase;
        cases.push(caseIdx);
        node.cases[caseIdx].forEach(
            node => processForSerialization(node, lView, cases, corruptedTextNodes));
      }
      break;
  }
}

interface DeserializationContext {
  lView: LView;
  disconnectedNodes: Set<number>;
  nodeMap: Map<number, RNode>;
  caseQueue: number[];
  hydrationInfo: DehydratedView;
}

/**
 * TODO: Updates the hydration info for the given LView, based on the serialized
 * i18n data, if available.
 *
 * In particular, this uses the serialized i18n data to walk over the AST and map
 * each LView to a given DOM element. This is used to update the `nodeMap` and
 * `disconnectedNodes` values in the LView's hydration info, so that Angular can
 * hydrate as usual.
 */
export function computeI18nDeserialization(lView: LView, index: number): void {
  const hydrationInfo = lView[HYDRATION];
  if (!hydrationInfo) {
    return;
  }

  const tView = lView[TVIEW];
  const tI18n = tView.data[index] as TI18n;
  const caseQueue = hydrationInfo?.data[I18N_ICU_DATA]?.[index - HEADER_OFFSET] ?? [];

  ngDevMode && assertDefined(tI18n, 'Expected i18n data');
  ngDevMode && assertDefined(tI18n.ast, 'Expected valid i18n data');

  const firstChildIndex = tI18n.ast[0].index;
  const tNode = tView.data[firstChildIndex] as TNode;
  const rootNode: Node = locateNextRNode(hydrationInfo, tView, lView, tNode) as Node;

  ngDevMode && assertDefined(rootNode, 'expected root node');

  const nodeMap = hydrationInfo.nodeMap ??= new Map();
  const disconnectedNodes = hydrationInfo.disconnectedNodes ??= new Set();

  const context: DeserializationContext = {
    lView,
    disconnectedNodes,
    nodeMap,
    caseQueue: [...caseQueue],
    hydrationInfo,
  };
  const state: HydrationState = {
    currentNode: rootNode,
  };
  computeDeserializationData(context, tI18n.ast, state);
}

interface HydrationState {
  currentNode: Node|null;
}

const enum MarkOptions {
  NONE = 0,
  CLAIM
}

function markHydrationRoot(
    context: DeserializationContext, astNode: I18nNode, state: HydrationState|null,
    options: MarkOptions): void {
  const noOffsetIndex = astNode.index - HEADER_OFFSET;
  const domNode = state?.currentNode;

  if (domNode != null) {
    context.nodeMap.set(noOffsetIndex, domNode);
    if (options === MarkOptions.CLAIM) {
      state!.currentNode = domNode.nextSibling;
    }
    context.disconnectedNodes.delete(noOffsetIndex);
  } else {
    context.disconnectedNodes.add(noOffsetIndex);
  }
}

function computeDeserializationData(
    context: DeserializationContext, astNodeOrNodes: I18nNode|I18nNode[],
    state: HydrationState|null) {
  if (Array.isArray(astNodeOrNodes)) {
    for (let i = 0; i < astNodeOrNodes.length; i++) {
      computeDeserializationData(context, astNodeOrNodes[i], state);
    }
  } else {
    const astNode = astNodeOrNodes;
    switch (astNode.kind) {
      case I18nNodeKind.TEXT: {
        markHydrationRoot(context, astNode, state, MarkOptions.CLAIM);
        break;
      }

      case I18nNodeKind.ELEMENT: {
        const childState =
            state == null ? null : {currentNode: state.currentNode?.firstChild ?? null};
        computeDeserializationData(context, astNode.children, childState);
        markHydrationRoot(context, astNode, state, MarkOptions.CLAIM);
        break;
      }

      case I18nNodeKind.PLACEHOLDER: {
        const containerSize =
            getNgContainerSize(context.hydrationInfo, astNode.index - HEADER_OFFSET);

        switch (astNode.type) {
          case I18nPlaceholderType.ELEMENT: {
            let childState = state;
            let markOptions = MarkOptions.NONE;

            if (containerSize == null) {
              // Elements have an actual representation in the DOM,
              // so we need to traverse their children, and continue
              // hydrating from the next sibling.
              childState =
                  state == null ? null : {currentNode: state.currentNode?.firstChild ?? null};
              markOptions = MarkOptions.CLAIM;
            }

            // Hydration expects to find the head of the element.
            markHydrationRoot(context, astNode, state, markOptions);
            computeDeserializationData(context, astNode.children, childState);

            if (containerSize != null && state?.currentNode) {
              // Skip over the anchor element for containers. The element
              // will be claimed when the container is hydrated.
              state.currentNode = state.currentNode.nextSibling;
            }
            break;
          }

          case I18nPlaceholderType.SUBTEMPLATE: {
            ngDevMode && assertNotEqual(containerSize, null, 'expected a container size');

            // Hydration expects to find the head of the template.
            markHydrationRoot(context, astNode, state, MarkOptions.NONE);

            if (state?.currentNode) {
              // Skip over the template children since the template will take care
              // of hydrating them.
              state.currentNode = siblingAfter(containerSize!, state.currentNode);

              // Also skip over the achor element. We don't include this in the
              // siblingAfter above because it's OK for the node to be null, such
              // as when we've reached the end of a leaf.
              state.currentNode = state.currentNode?.nextSibling ?? null;
            }
            break;
          }
        }
        break;
      }

      case I18nNodeKind.ICU: {
        const selectedCase = state?.currentNode ? context.caseQueue.shift()! : null;
        for (let i = 0; i < astNode.cases.length; i++) {
          computeDeserializationData(context, astNode.cases[i], selectedCase === i ? state : null);
        }
        markHydrationRoot(context, astNode, state, MarkOptions.CLAIM);
        break;
      }
    }
  }
}
