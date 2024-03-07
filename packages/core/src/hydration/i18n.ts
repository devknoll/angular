/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {I18nNode, I18nNodeKind, I18nPlaceholderType, TI18n} from '../render3/interfaces/i18n';
import {TNode} from '../render3/interfaces/node';
import {RNode} from '../render3/interfaces/renderer_dom';
import {HEADER_OFFSET, HYDRATION, LView, TVIEW} from '../render3/interfaces/view';
import {unwrapRNode} from '../render3/util/view_utils';
import {assertDefined, assertGreaterThanOrEqual, assertNotEqual} from '../util/assert';

import type {HydrationContext} from './annotate';
import {DISCONNECTED_NODES, I18N_DATA} from './interfaces';
import {locateNextRNode, siblingAfter} from './node_lookup_utils';
import {getNgContainerSize, processTextNodeBeforeSerialization} from './utils';

let _isI18nHydrationSupportEnabled = false;

export function setIsI18nHydrationSupportEnabled(enabled: boolean) {
  _isI18nHydrationSupportEnabled = enabled;
}

export function isI18nHydrationSupportEnabled() {
  return _isI18nHydrationSupportEnabled;
}

function trySerializeI18nBlockImpl(
    lView: LView, index: number, context: HydrationContext): Array<number>|null {
  if (!context.enableI18nHydration) {
    return null;
  }

  const tView = lView[TVIEW];
  const tI18n = tView.data[index] as TI18n | undefined;

  if (!tI18n || !tI18n.ast) {
    return null;
  }

  const icuCases: number[] = [];
  function serializeI18nBlock(node: I18nNode) {
    switch (node.kind) {
      case I18nNodeKind.TEXT:
        const rNode = unwrapRNode(lView[node.index]!);
        processTextNodeBeforeSerialization(context, rNode);
        break;

      case I18nNodeKind.ELEMENT:
      case I18nNodeKind.PLACEHOLDER:
        node.children.forEach(serializeI18nBlock);
        break;

      case I18nNodeKind.ICU:
        const currentCase = lView[node.currentCaseLViewIndex] as number | null;
        if (currentCase != null) {
          // i18n uses a negative value to signal a change to a new case, so we
          // need to invert it to get the proper value.
          const caseIdx = currentCase < 0 ? ~currentCase : currentCase;
          icuCases.push(caseIdx);
          node.cases[caseIdx].forEach(serializeI18nBlock);
        }
        break;
    }
  }

  tI18n.ast.forEach(serializeI18nBlock);
  return icuCases.length > 0 ? icuCases : null;
}

let _trySerializeI18nBlockImpl: typeof trySerializeI18nBlockImpl = () => {
  // noop unless `enableTrySerializeI18nBlock` is invoked.
  return null;
};

export function enableTrySerializeI18nBlockImpl() {
  _trySerializeI18nBlockImpl = trySerializeI18nBlockImpl;
}

/**
 * Attempts to serialize i18n data for the given i18n block.
 *
 * @param lView lView with the i18n block
 * @param index index of the i18n block in the lView
 * @param processTextNode callback run for text nodes
 * @returns the i18n data, or null if there is no relevant data
 */
export function trySerializeI18nBlock(
    lView: LView, index: number, context: HydrationContext): Array<number>|null {
  return _trySerializeI18nBlockImpl(lView, index, context);
}

function prepareI18nBlockForHydrationImpl(lView: LView, index: number) {
  if (!isI18nHydrationSupportEnabled()) {
    return;
  }

  const hydrationInfo = lView[HYDRATION];
  if (!hydrationInfo) {
    return;
  }

  const tView = lView[TVIEW];
  const tI18n = tView.data[index] as TI18n;

  ngDevMode &&
      assertDefined(
          tI18n, 'Expected i18n data to be present in a given TView slot during hydration');

  const firstNode = tI18n.ast[0];
  if (!firstNode) {
    return;
  }

  const tNode = tView.data[firstNode.index] as TNode;
  const rootNode = locateNextRNode(hydrationInfo, tView, lView, tNode) as Node;

  ngDevMode && assertDefined(rootNode, '');

  const disconnectedNodes = hydrationInfo.disconnectedNodes ??=
      new Set(hydrationInfo.data[DISCONNECTED_NODES] ?? []);
  const i18nMap = hydrationInfo.i18nNodes ??= new Map();
  const caseQueue = hydrationInfo.data[I18N_DATA]?.[index - HEADER_OFFSET] ?? [];

  interface HydrationState {
    currentNode: Node|null;
  }

  const enum MarkOptions {
    NONE = 0,
    CLAIM,
  }

  function markHydrationRoot(node: I18nNode, state: HydrationState|null, options: MarkOptions) {
    const noOffsetIndex = node.index - HEADER_OFFSET;
    const domNode = state?.currentNode;

    if (domNode) {
      i18nMap.set(noOffsetIndex, domNode);
      if (options === MarkOptions.CLAIM) {
        state.currentNode = domNode.nextSibling;
      }

      disconnectedNodes.delete(noOffsetIndex);
    } else {
      disconnectedNodes.add(noOffsetIndex);
    }
  }

  function prepareForHydration(nodeOrNodes: I18nNode|I18nNode[], state: HydrationState|null) {
    if (Array.isArray(nodeOrNodes)) {
      for (let i = 0; i < nodeOrNodes.length; i++) {
        prepareForHydration(nodeOrNodes[i], state);
      }
    } else {
      switch (nodeOrNodes.kind) {
        case I18nNodeKind.TEXT:
          // Claim a text node for hydration
          markHydrationRoot(nodeOrNodes, state, MarkOptions.CLAIM);
          break;

        case I18nNodeKind.ELEMENT:
          // Recurse into the current element's children...
          const childState = state ? {currentNode: state.currentNode?.firstChild ?? null} : null;
          prepareForHydration(nodeOrNodes.children, childState);

          // And claim the parent element itself.
          markHydrationRoot(nodeOrNodes, state, MarkOptions.CLAIM);
          break;

        case I18nNodeKind.PLACEHOLDER:
          const containerSize =
              getNgContainerSize(hydrationInfo!, nodeOrNodes.index - HEADER_OFFSET);

          switch (nodeOrNodes.type) {
            case I18nPlaceholderType.ELEMENT:
              let childState = state;
              let markOptions = MarkOptions.NONE;

              if (containerSize == null) {
                // Non-container elements represent an actual node in the DOM,
                // so we need to traverse their children.
                childState = state ? {currentNode: state.currentNode?.firstChild ?? null} : null;
                markOptions = MarkOptions.CLAIM;
              }

              // Hydration expects to find the head of the element.
              markHydrationRoot(nodeOrNodes, state, markOptions);
              prepareForHydration(nodeOrNodes.children, childState);

              if (containerSize != null && state?.currentNode) {
                // Skip over the anchor element for containers. The element will
                // be claimed when the container hydrates.
                state.currentNode = state.currentNode.nextSibling;
              }
              break;

            case I18nPlaceholderType.SUBTEMPLATE:
              ngDevMode && assertNotEqual(containerSize, null, 'expected a container size');

              // Hydration expects to find the head of the template.
              markHydrationRoot(nodeOrNodes, state, MarkOptions.NONE);

              if (state?.currentNode) {
                // Skip over the template children, since the template itself
                // will take care of preparing and hydrating them.
                state.currentNode = siblingAfter(containerSize!, state.currentNode);

                // Also skip over the anchor element. We don't include this in the
                // `siblingAfter` call above, because it's OK for the anchor to
                // not have a sibling, such as when it's the last child.
                state.currentNode = state.currentNode?.nextSibling ?? null;
              }
              break;
          }
          break;

        case I18nNodeKind.ICU:
          // Pop the next ICU case off the queue
          const selectedCase = state?.currentNode ? caseQueue.shift()! : null;

          // We traverse through each case, even if it's not selected,
          // so that we correctly populate disconnected nodes.
          for (let i = 0; i < nodeOrNodes.cases.length; i++) {
            prepareForHydration(nodeOrNodes.cases[i], i === selectedCase ? state : null);
          }

          markHydrationRoot(nodeOrNodes, state, MarkOptions.CLAIM);
          break;
      }
    }
  }

  prepareForHydration(tI18n.ast, {currentNode: rootNode});
}

let _prepareI18nBlockForHydrationImpl: typeof prepareI18nBlockForHydrationImpl = (lView, index) => {
  // noop unless `enablePrepareI18nBlockForHydrationImpl` is invoked.
};

/**
 * Prepares the given i18n block (corresponding to the view and instruction index)
 * and its children for hydration.
 *
 * @param lView lView with the i18n block
 * @param index index of the i18n block in the lView
 */
export function prepareI18nBlockForHydration(lView: LView, index: number): void {
  _prepareI18nBlockForHydrationImpl(lView, index);
}

export function enablePrepareI18nBlockForHydrationImpl() {
  _prepareI18nBlockForHydrationImpl = prepareI18nBlockForHydrationImpl;
}
