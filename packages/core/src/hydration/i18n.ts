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
import {assertDefined, assertNotEqual} from '../util/assert';

import type {HydrationContext} from './annotate';
import {DehydratedView, I18N_DATA} from './interfaces';
import {locateNextRNode} from './node_lookup_utils';
import {getNgContainerSize, initDisconnectedNodes, processTextNodeBeforeSerialization} from './utils';

let _isI18nHydrationSupportEnabled = false;

let _prepareI18nBlockForHydrationImpl: typeof prepareI18nBlockForHydrationImpl = (lView, index) => {
  // noop unless `enablePrepareI18nBlockForHydrationImpl` is invoked.
};

let _trySerializeI18nBlockImpl: typeof trySerializeI18nBlockImpl = () => {
  // noop unless `enableTrySerializeI18nBlock` is invoked.
  return null;
};

export function setIsI18nHydrationSupportEnabled(enabled: boolean) {
  _isI18nHydrationSupportEnabled = enabled;
}

export function isI18nHydrationSupportEnabled() {
  return _isI18nHydrationSupportEnabled;
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

export function enableTrySerializeI18nBlockImpl() {
  _trySerializeI18nBlockImpl = trySerializeI18nBlockImpl;
}

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

  const firstAstNode = tI18n.ast[0];
  if (firstAstNode) {
    // We begin hydration at the RNode for the first child. Top-level AST nodes will always
    // have a valid TNode, so we can use the normal `locateNextRNode` to find it. It's OK if
    // nothing is located, as that also means that there is nothing to clean up. Downstream
    // error handling will detect this and provide proper context.
    const tNode = tView.data[firstAstNode.index] as TNode;
    const rootNode = locateNextRNode(hydrationInfo, tView, lView, tNode) as Node | null;

    const disconnectedNodes = initDisconnectedNodes(hydrationInfo) ?? new Set();
    const i18nMap = hydrationInfo.i18nNodes ??= new Map<number, RNode|null>();
    const caseQueue = hydrationInfo.data[I18N_DATA]?.[index - HEADER_OFFSET] ?? [];

    prepareForHydration(
        {hydrationInfo, i18nMap, disconnectedNodes, caseQueue},
        {currentNode: rootNode, isConnected: true}, tI18n.ast);

    // During i18n hydration, we may have discovered disconnected nodes that weren't
    // serialized, so we need to write the expected value back.
    hydrationInfo.disconnectedNodes = disconnectedNodes.size === 0 ? null : disconnectedNodes;
  }
}

/**
 * Describes shared data available during the hydration process.
 */
interface I18nHydrationContext {
  hydrationInfo: DehydratedView;
  i18nMap: Map<number, RNode|null>;
  disconnectedNodes: Set<number>;
  caseQueue: number[];
}

/**
 * Describes current hydration state.
 */
interface I18nHydrationState {
  // The current node
  currentNode: RNode|null;

  /**
   * Whether the tree should be connected.
   *
   * During hydration, it can happen that we expect to have a
   * current RNode, but we don't. In such cases, we still need
   * to propagate the expectation to the corresponding LViews,
   * so that the proper downstream error handling can provide
   * the correct context for the error.
   */
  isConnected: boolean;
}

/**
 * Flags for use in `markHydrationRoot`
 */
const enum MarkOptions {
  // No flags
  NONE = 0,

  // Claim the current node and move to the next one.
  CLAIM,
}

/**
 * Marks the current RNode as the hydration root for the given
 * AST node.
 */
function markHydrationRoot(
    context: I18nHydrationContext, state: I18nHydrationState, astNode: I18nNode,
    options: MarkOptions) {
  const noOffsetIndex = astNode.index - HEADER_OFFSET;
  const {disconnectedNodes, i18nMap} = context;
  const currentNode = state.currentNode;

  if (state.isConnected) {
    i18nMap.set(noOffsetIndex, currentNode);
    if (currentNode) {
      if (options === MarkOptions.CLAIM) {
        state.currentNode = currentNode.nextSibling;
      }
    }
    // We expect the node to be connected, so remove it from
    // the set, regardless of whether we found it, so that the
    // downstream error handling can provide proper context.
    disconnectedNodes.delete(noOffsetIndex);
  } else {
    disconnectedNodes.add(noOffsetIndex);
  }
}

/**
 * Skip over some nodes during hydration.
 *
 * Note: we use this instead of `siblingAfter` as it's expected that
 * sometimes we might encounter null nodes. In those cases, we want to
 * defer to downstream error handling to provide proper context.
 */
function skipHydrationNodes(state: I18nHydrationState, skip: number) {
  let currentNode = state.currentNode;
  for (let i = 0; i < skip; i++) {
    if (!currentNode) {
      break;
    }
    currentNode = currentNode?.nextSibling ?? null;
  }
  state.currentNode = currentNode;
}

/**
 * Fork the given state into a new state for hydrating children.
 */
function forkChildHydrationState(state: I18nHydrationState) {
  return {currentNode: state.currentNode?.nextSibling ?? null, isConnected: state.isConnected};
}

function prepareForHydration(
    context: I18nHydrationContext, state: I18nHydrationState, nodeOrNodes: I18nNode|I18nNode[]) {
  if (Array.isArray(nodeOrNodes)) {
    for (let i = 0; i < nodeOrNodes.length; i++) {
      prepareForHydration(context, state, nodeOrNodes[i]);
    }
  } else {
    switch (nodeOrNodes.kind) {
      case I18nNodeKind.TEXT:
        // Claim a text node for hydration
        markHydrationRoot(context, state, nodeOrNodes, MarkOptions.CLAIM);
        break;

      case I18nNodeKind.ELEMENT:
        // Recurse into the current element's children...
        prepareForHydration(context, forkChildHydrationState(state), nodeOrNodes.children);

        // And claim the parent element itself.
        markHydrationRoot(context, state, nodeOrNodes, MarkOptions.CLAIM);
        break;

      case I18nNodeKind.PLACEHOLDER:
        const containerSize =
            getNgContainerSize(context.hydrationInfo, nodeOrNodes.index - HEADER_OFFSET);

        switch (nodeOrNodes.type) {
          case I18nPlaceholderType.ELEMENT:
            let childState = state;
            let markOptions = MarkOptions.NONE;

            if (containerSize === null) {
              // Non-container elements represent an actual node in the DOM,
              // so we need to traverse their children.
              childState = forkChildHydrationState(state);
              markOptions = MarkOptions.CLAIM;
            }

            // Hydration expects to find the head of the element.
            markHydrationRoot(context, state, nodeOrNodes, markOptions);
            prepareForHydration(context, childState, nodeOrNodes.children);

            if (containerSize != null) {
              // Skip over the anchor element for containers. The element will
              // be claimed when the container hydrates.
              skipHydrationNodes(state, 1);
            }
            break;

          case I18nPlaceholderType.SUBTEMPLATE:
            ngDevMode &&
                assertNotEqual(
                    containerSize, null,
                    'Expected a container size while hydrating i18n subtemplate');

            // Hydration expects to find the head of the template.
            markHydrationRoot(context, state, nodeOrNodes, MarkOptions.NONE);

            // Skip over the template children, since the template itself
            // will take care of preparing and hydrating them.
            skipHydrationNodes(state, containerSize! + 1);
            break;
        }
        break;

      case I18nNodeKind.ICU:
        // If the current node is attached, we need to pop the next case from the
        // queue, so that the active case is also considered attached.
        const selectedCase = state.isConnected ? context.caseQueue.shift()! : null;
        const childState = {currentNode: null, isConnected: false};

        // We traverse through each case, even if it's not selected,
        // so that we correctly populate disconnected nodes.
        for (let i = 0; i < nodeOrNodes.cases.length; i++) {
          prepareForHydration(
              context, i === selectedCase ? state : childState, nodeOrNodes.cases[i]);
        }

        // Hydration expects to find the ICU anchor element.
        markHydrationRoot(context, state, nodeOrNodes, MarkOptions.CLAIM);
        break;
    }
  }
}
