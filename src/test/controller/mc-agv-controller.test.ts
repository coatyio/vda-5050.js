/*! Copyright (c) 2021 Siemens AG. Licensed under the MIT License. */

import * as tap from "tap";

import {
    Action,
    ActionStatus,
    AgvController,
    AgvControllerOptions,
    AgvId,
    BlockingType,
    createUuid,
    ErrorLevel,
    ErrorType,
    EStop,
    Headerless,
    MasterController,
    OperatingMode,
    Order,
    Topic,
    VirtualAgvAdapter,
    VirtualAgvAdapterOptions,
} from "../..";

import { initTestContext, testClientOptions } from "../test-context";
import { createAgvId } from "../test-objects";

function getHeaderlessOrder(order: Order): Headerless<Order> {
    const shallowCopy = { ...order };
    delete shallowCopy.headerId;
    delete shallowCopy.manufacturer;
    delete shallowCopy.serialNumber;
    delete shallowCopy.version;
    delete shallowCopy.timestamp;
    return shallowCopy;
}

function createHeaderlessOrder(nodeActions = [[createPickDropAction("pick")], [createPickDropAction("drop")]]): Headerless<Order> {
    return {
        orderId: createUuid(),
        orderUpdateId: 0,
        nodes: [
            {
                nodeId: "productionunit_1",
                sequenceId: 0,
                released: true,
                nodePosition: { x: 0, y: 0, mapId: "local" },
                actions: nodeActions[0],
            },
            {
                nodeId: "productionunit_2",
                sequenceId: 2,
                released: true,
                nodePosition: { x: 100, y: 0, mapId: "local" },
                actions: nodeActions[1],
            },
        ],
        edges: [
            {
                edgeId: "productionunit_1_2",
                sequenceId: 1,
                startNodeId: "productionunit_1",
                endNodeId: "productionunit_2",
                released: true,
                actions: [],
            },
        ],
    };
}

function createPickDropAction(actionType: "pick" | "drop", blockingType = BlockingType.Hard): Action {
    return {
        actionId: createUuid(),
        actionType,
        blockingType,
        actionParameters: [{ key: "stationType", value: "floor" }, { key: "loadType", value: "EPAL" }],
    };
}

async function testOrderError(
    test: typeof tap.Test.prototype,
    testName: string,
    errorType: ErrorType,
    mc: MasterController,
    agvId: AgvId,
    order: Headerless<Order>,
    withStateChange: { ac: AgvController, keyChain: string, newValue: any },
    ...expectedErrorRefs: Array<{ referenceKey: string, referenceValue: string }>) {
    await test.test(testName, ts => new Promise(async resolve => {

        let currentState: any;
        if (withStateChange) {
            currentState = withStateChange.ac.currentState;
            const newState = JSON.parse(JSON.stringify(currentState));
            const keys = withStateChange.keyChain.split(".");
            let keyValue = newState;
            for (const key of keys.slice(0, keys.length - 1)) {
                keyValue = keyValue[key];
            }
            keyValue[keys[keys.length - 1]] = withStateChange.newValue;
            withStateChange.ac.updatePartialState(newState, false);
        }

        let errorInvocations = 0;
        const headeredOrder = await mc.assignOrder(agvId, order, {
            onOrderProcessed: (withError, byCancelation, active, context) => {
                errorInvocations++;
                ts.equal(errorInvocations, 1);
                ts.equal(byCancelation, false);
                ts.equal(active, false);
                ts.notEqual(withError, undefined);
                ts.equal(withError.errorLevel, ErrorLevel.Warning);
                ts.equal(withError.errorType, errorType);
                ts.true(withError.errorReferences.some(r => r.referenceKey === "orderId" && r.referenceValue === order.orderId));
                ts.true(!withError.errorReferences.some(r => r.referenceKey === "orderUpdateId"));
                ts.true(!withError.errorReferences.some(r => r.referenceKey === "topic") ||
                    withError.errorReferences.some(r => r.referenceKey === "topic" && r.referenceValue === Topic.Order));
                ts.true(!withError.errorReferences.some(r => r.referenceKey === "headerId") ||
                    withError.errorReferences.some(r => r.referenceKey === "headerId" &&
                        r.referenceValue === headeredOrder.headerId.toString()));
                ts.true(expectedErrorRefs.every(er => withError.errorReferences.some(r =>
                    r.referenceKey === er.referenceKey && r.referenceValue === er.referenceValue)));
                ts.strictDeepEqual(context.agvId, agvId);
                ts.equal(context.order, headeredOrder);

                if (withStateChange) {
                    withStateChange.ac.updatePartialState(currentState);
                }
                resolve();
            },
        });
    }));
}

async function testOrder(
    test: typeof tap.Test.prototype,
    testName: string,
    mc: MasterController,
    agvId: AgvId,
    order: Headerless<Order>,
    expectedChanges: {
        // true if order is completely processed, i.e. without outstanding horizon nodes/edges;
        // false if order is processed but still active because of horizin nodes/edges.
        completes: boolean,
        canceled?: boolean,
        discarded?: boolean,
        errorRefs?: Array<{ referenceKey: string, referenceValue: string }>,
        actionErrorRefs?: Array<{ referenceKey: string, referenceValue: string }>,
    },
    failAfter?: number) {
    await test.test(testName, ts => new Promise(async resolve => {
        if (failAfter !== undefined) {
            setTimeout(() => {
                ts.pass("test timed out as expected after " + failAfter + "ms");
                resolve();
            }, failAfter);
        }

        let processedInvocations = 0;
        let nodeTraversedIndex = -1;
        let edgeTraversedIndex = -1;
        let edgeTraversingCount = 0;
        const headeredOrder = await mc.assignOrder(agvId, order, {
            onOrderProcessed: (withError, byCancelation, active, context) => {
                if (failAfter !== undefined) {
                    ts.fail("onOrderProcessed should not be called due to failAfter timeout");
                    resolve();
                    return;
                }
                if (expectedChanges.discarded) {
                    ts.fail("onOrderProcessed should not be called as order should be discarded");
                    resolve();
                    return;
                }
                ts.equal(expectedChanges.completes, !active);
                ts.equal(byCancelation, !!expectedChanges.canceled);
                if (!expectedChanges.completes && expectedChanges.canceled) {
                    // Test has already ended, do not invoke asserts on it.
                    return;
                }
                processedInvocations++;
                ts.equal(processedInvocations, 1);
                ts.strictDeepEqual(context.agvId, agvId);
                ts.equal(context.order, headeredOrder);

                if (expectedChanges.errorRefs?.length > 0) {
                    ts.notEqual(withError, undefined);
                    ts.true(expectedChanges.errorRefs.every(er => withError.errorReferences.some(r =>
                        r.referenceKey === er.referenceKey && r.referenceValue === er.referenceValue)));
                } else {
                    ts.equal(withError, undefined);
                }

                resolve();
            },
            onNodeTraversed: (node, nextEdge, nextNode, context) => {
                if (failAfter !== undefined) {
                    ts.fail("onNodeTraversed should not be called because of failAfter timeout");
                    resolve();
                    return;
                }
                nodeTraversedIndex++;
                ts.equal(edgeTraversingCount, 0);
                ts.equal(nodeTraversedIndex, edgeTraversedIndex + 1);
                ts.equal(node, context.order.nodes[nodeTraversedIndex]);
                ts.equal(nextEdge, context.order.edges[nodeTraversedIndex]);
                ts.equal(nextNode, context.order.nodes[nodeTraversedIndex + 1]);
                ts.strictDeepEqual(context.agvId, agvId);
                ts.equal(context.order, headeredOrder);
                ts.strictDeepEqual(getHeaderlessOrder(context.order), order);
                if (node.nodePosition) {
                    ts.equal(context.state.agvPosition.positionInitialized, true);
                    ts.equal(context.state.agvPosition.mapId, node.nodePosition.mapId);
                    ts.equal(context.state.agvPosition.x, node.nodePosition.x);
                    ts.equal(context.state.agvPosition.y, node.nodePosition.y);
                    if (node.nodePosition.theta !== undefined) {
                        ts.equal(context.state.agvPosition.theta, node.nodePosition.theta);
                    }
                }
                if (!expectedChanges.completes && !nextEdge?.released) {
                    ts.pass("last released node traversed - order has more unreleased nodes");
                    resolve();
                }
            },
            onEdgeTraversed: (edge, startNode, endNode, context) => {
                if (failAfter !== undefined) {
                    ts.fail("onEdgeTraversed should not be called because of failAfter timeout");
                    resolve();
                    return;
                }
                edgeTraversingCount = 0;
                edgeTraversedIndex++;
                ts.equal(nodeTraversedIndex, edgeTraversedIndex);
                ts.equal(edge, context.order.edges[edgeTraversedIndex]);
                ts.equal(startNode, context.order.nodes[edgeTraversedIndex]);
                ts.equal(endNode, context.order.nodes[edgeTraversedIndex + 1]);
                ts.strictDeepEqual(context.agvId, agvId);
                ts.equal(context.order, headeredOrder);
                ts.strictDeepEqual(getHeaderlessOrder(context.order), order);
            },
            onEdgeTraversing: (edge, startNode, endNode, stateChanges, invocationCount, context) => {
                if (failAfter !== undefined) {
                    ts.fail("onEdgeTraversing should not be called because of failAfter timeout");
                    resolve();
                    return;
                }
                edgeTraversingCount++;
                ts.equal(edgeTraversingCount, invocationCount);
                ts.equal(nodeTraversedIndex, edgeTraversedIndex + 1);
                ts.equal(edge, context.order.edges[edgeTraversedIndex + 1]);
                ts.equal(startNode, context.order.nodes[edgeTraversedIndex + 1]);
                ts.equal(endNode, context.order.nodes[edgeTraversedIndex + 2]);
                ts.strictDeepEqual(context.agvId, agvId);
                ts.equal(context.order, headeredOrder);
                ts.strictDeepEqual(getHeaderlessOrder(context.order), order);
                if (edgeTraversingCount === 1) {
                    ts.equal(stateChanges.distanceSinceLastNode, undefined);
                    // ts.equal(stateChanges.driving, false);
                    ts.equal(stateChanges.newBaseRequest, undefined);
                    ts.equal(stateChanges.operatingMode, OperatingMode.Automatic);
                    // @todo make parameterizable for startPause/stopPause tests
                    // ts.equal(stateChanges.paused, false);
                    ts.equal(stateChanges.safetyState.eStop, EStop.None);
                    ts.equal(stateChanges.safetyState.fieldViolation, false);
                } else {
                    ts.equal("distanceSinceLastNode" in stateChanges, false);
                    ts.equal("newBaseRequest" in stateChanges, false);
                    ts.equal("operatingMode" in stateChanges, false);
                    // @todo make parameterizable for startPause/stopPause tests
                    // ts.equal("paused" in stateChanges, false);
                    ts.equal("safetyState" in stateChanges, false);
                }
            },
            onActionStateChanged: (actionState, withError, action, target, context) => {
                if (failAfter !== undefined) {
                    ts.fail("onActionStateChanged should not be called because of failAfter timeout");
                    resolve();
                    return;
                }
                const targetActions = target.actions;
                const actionIndex = targetActions.indexOf(action);
                ts.notEqual(actionIndex, -1);
                ts.equal(actionState.actionType, action.actionType);
                ts.equal(actionState.actionId, action.actionId);
                ts.equal(actionState.actionDescription, action.actionDescription);

                if (actionState.actionStatus === ActionStatus.Failed && expectedChanges.actionErrorRefs?.length > 0) {
                    ts.notEqual(withError, undefined);
                    ts.equal(withError.errorType, ErrorType.OrderAction);
                    ts.true(expectedChanges.actionErrorRefs.every(er => withError.errorReferences.some(r =>
                        r.referenceKey === er.referenceKey && r.referenceValue === er.referenceValue)));
                } else {
                    ts.equal(withError, undefined);
                }
            },
        });

        if (headeredOrder === undefined) {
            if (expectedChanges.discarded) {
                ts.pass("Assigned order has been discarded by mc");
            } else {
                ts.fail("Assigned order has been discarded by mc");
            }
            resolve();
        }
    }));
}

initTestContext(tap);

// Adjust test timeout on top level to complete all subtests in time.
tap.setTimeout(30000);

tap.test("Master Controller - AGV Controller", async t => {
    const agvId1 = createAgvId("RobotCompany", "001");
    const agvId2 = createAgvId("RobotCompany", "002");

    const mcController = new MasterController(testClientOptions(t), {});
    const mcControllerWithoutValidation = new MasterController({
        ...testClientOptions(t),
        topicObjectValidation: { inbound: true, outbound: false },
    }, {});

    const agvControllerOptions1: AgvControllerOptions = { agvAdapterType: VirtualAgvAdapter };
    const agvAdapterOptions1: VirtualAgvAdapterOptions = { initialBatteryCharge: 80, timeLapse: 100 };
    const agvController1 = new AgvController(agvId1, testClientOptions(t), agvControllerOptions1, agvAdapterOptions1);

    const agvControllerOptions2: AgvControllerOptions = { agvAdapterType: VirtualAgvAdapter, publishVisualizationInterval: 0 };
    const agvAdapterOptions2: VirtualAgvAdapterOptions = { initialBatteryCharge: 80, timeLapse: 100 };
    const agvController2 = new AgvController(agvId2, testClientOptions(t), agvControllerOptions2, agvAdapterOptions2);

    t.tearDown(() => agvController1.stop());
    t.tearDown(() => agvController2.stop());
    t.tearDown(() => mcController.stop());
    t.tearDown(() => mcControllerWithoutValidation.stop());

    await t.test("start AGV Controller 1", () => agvController1.start());
    await t.test("start AGV Controller 2", () => agvController2.start());
    await t.test("start Master Controller", () => mcController.start());
    await t.test("start Master Controller without validation", () => mcControllerWithoutValidation.start());

    /* Isolated VirtualAgvAdapter tests */

    t.test("adapter name", ts => {
        ts.equal(agvController1["_agvAdapter"].name, "VirtualAgvAdapter");
        ts.end();
    });

    /* Isolated Visualization tests */

    await t.test("visualization received while not driving", ts => new Promise(async resolve => {
        let invocations = 0;
        let lastTimestamp: string;
        await mcController.subscribe(Topic.Visualization, agvId1, async (vis, _agvId, _topic, subscriptionId) => {
            invocations++;
            ts.strictDeepEqual(vis.agvPosition, { x: 0, y: 0, theta: 0, mapId: "local", positionInitialized: true });
            ts.strictDeepEqual(vis.velocity, { vx: 0, vy: 0, omega: 0 });
            if (lastTimestamp !== undefined) {
                ts.notEqual(lastTimestamp, vis.timestamp);
            }
            lastTimestamp = vis.timestamp;

            if (invocations === 3) {
                await mcController.unsubscribe(subscriptionId);
                resolve();
            }
        });
    }));

    await t.test("visualization not received if feature disabled", ts => new Promise(async resolve => {
        let tsFailed = false;
        const subscriptionId = await mcController.subscribe(Topic.Visualization, agvId2, async () => {
            tsFailed = true;
        });
        setTimeout(async () => {
            tsFailed ?
                ts.fail("visualization should not have been received") :
                ts.pass("no visualization received");
            await mcController.unsubscribe(subscriptionId);
            resolve();
        }, 3000);
    }));

    /* Isolated instant action tests */

    await t.test("instant action invalid - not well-formed", ts => new Promise(async resolve => {
        let errorInvocations = 0;
        const actions = await mcControllerWithoutValidation.initiateInstantActions(agvId1, {
            instantActions: [{
                actionId: createUuid(),
                actionType: 42,
                blockingType: BlockingType.Hard,
            } as unknown as Action],
        }, {
            onActionStateChanged: () => {
                ts.fail("onActionStateChanged should never be called");
                resolve();
            },
            onActionError: (error, action) => {
                errorInvocations++;
                ts.equal(errorInvocations, 1);
                ts.strictDeepEqual(action, actions.instantActions[0]);
                ts.equal(error.errorLevel, ErrorLevel.Warning);
                ts.equal(error.errorType, ErrorType.InstantActionValidation);
                ts.true(!error.errorReferences.some(r => r.referenceKey === "topic") ||
                    error.errorReferences.some(r => r.referenceKey === "topic" && r.referenceValue === Topic.InstantActions));
                resolve();
            },
        });
    }));

    await t.test("instant action cancelOrder rejected with error", ts => new Promise(async resolve => {
        let errorInvocations = 0;
        const actions = await mcController.initiateInstantActions(agvId1, {
            instantActions: [{
                actionId: createUuid(),
                actionType: "cancelOrder",
                blockingType: BlockingType.Hard,
            }],
        }, {
            onActionStateChanged: () => {
                ts.fail("onActionStateChanged should never be called");
                resolve();
            },
            onActionError: (error, action) => {
                errorInvocations++;
                ts.equal(errorInvocations, 1);
                ts.strictDeepEqual(action, actions.instantActions[0]);
                ts.equal(error.errorLevel, ErrorLevel.Warning);
                ts.equal(error.errorType, ErrorType.InstantActionNoOrderToCancel);
                ts.true(!error.errorReferences.some(r => r.referenceKey === "topic") ||
                    error.errorReferences.some(r => r.referenceKey === "topic" && r.referenceValue === Topic.InstantActions));
                ts.true(error.errorReferences.some(r => r.referenceKey === "actionId" && r.referenceValue === action.actionId));
                resolve();
            },
        });
    }));

    await t.test("instant action pick rejected with error", ts => new Promise(async resolve => {

        let errorInvocations = 0;
        const actions = await mcController.initiateInstantActions(agvId1, {
            instantActions: [createPickDropAction("pick")],
        }, {
            onActionStateChanged: () => {
                ts.fail("onActionStateChanged should never be called");
                resolve();
            },
            onActionError: (error, action) => {
                errorInvocations++;
                ts.equal(errorInvocations, 1);
                ts.strictDeepEqual(action, actions.instantActions[0]);
                ts.equal(error.errorLevel, ErrorLevel.Warning);
                ts.equal(error.errorType, ErrorType.InstantAction);
                ts.true(!error.errorReferences.some(r => r.referenceKey === "topic") ||
                    error.errorReferences.some(r => r.referenceKey === "topic" && r.referenceValue === Topic.InstantActions));
                ts.true(error.errorReferences.some(r => r.referenceKey === "actionId" && r.referenceValue === action.actionId));
                resolve();
            },
        });
    }));

    await t.test("instant action initPosition twice in series as hard blocking action", ts => new Promise(async resolve => {
        let actionStateInvocations = 0;
        const actions = await mcController.initiateInstantActions(agvId1, {
            instantActions: [{
                actionId: createUuid(),
                actionDescription: "initialize position to x:10 y:10 on floor2 map",
                actionType: "initPosition",
                blockingType: BlockingType.Hard,
                actionParameters: [
                    { key: "x", value: 10 },
                    { key: "y", value: 10 },
                    { key: "theta", value: 0 },
                    { key: "mapId", value: "floor2" },
                    { key: "lastNodeId", value: "n1" },
                    { key: "lastNodeSequenceId", value: 1 },
                ],
            },
            {
                actionId: createUuid(),
                actionDescription: "initialize position to x:0 y:0 on local map",
                actionType: "initPosition",
                blockingType: BlockingType.Hard,
                actionParameters: [
                    { key: "x", value: 0 },
                    { key: "y", value: 0 },
                    { key: "theta", value: 0 },
                    { key: "mapId", value: "local" },
                    { key: "lastNodeId", value: "" },
                ],
            }],
        }, {
            onActionStateChanged: (actionState, withError, action, _agvId, state) => {
                actionStateInvocations++;
                ts.true(actionStateInvocations === 1 || actionStateInvocations === 2);
                if (actionStateInvocations === 1) {
                    ts.strictDeepEqual(action, actions.instantActions[0]);
                    ts.equal(withError, undefined);
                    ts.equal(actionState.actionId, actions.instantActions[0].actionId);
                    ts.equal(actionState.actionStatus, ActionStatus.Finished);
                    ts.equal(actionState.actionDescription, actions.instantActions[0].actionDescription);
                    ts.equal(actionState.resultDescription, "Position initialized");
                    ts.strictDeepEqual(state.agvPosition, { x: 10, y: 10, theta: 0, mapId: "floor2", positionInitialized: true });
                    ts.equal(state.lastNodeId, "n1");
                    ts.equal(state.lastNodeSequenceId, 1);
                } else {
                    ts.strictDeepEqual(action, actions.instantActions[1]);
                    ts.equal(withError, undefined);
                    ts.equal(actionState.actionId, actions.instantActions[1].actionId);
                    ts.equal(actionState.actionStatus, ActionStatus.Finished);
                    ts.equal(actionState.actionDescription, actions.instantActions[1].actionDescription);
                    ts.equal(actionState.resultDescription, "Position initialized");
                    ts.strictDeepEqual(state.agvPosition, { x: 0, y: 0, theta: 0, mapId: "local", positionInitialized: true });
                    ts.equal(state.lastNodeId, "");
                    ts.equal(state.lastNodeSequenceId, 0);
                    resolve();
                }
            },
            onActionError: () => {
                ts.fail("onActionError should never be called");
                resolve();
            },
        });
    }));

    await t.test("instant actions startPause-stopPause in series as hard blocking actions", ts => new Promise(async resolve => {
        let actionStateInvocations = 0;
        const actions = await mcController.initiateInstantActions(agvId1, {
            instantActions: [{
                actionId: createUuid(),
                actionType: "startPause",
                blockingType: BlockingType.Hard,
            },
            {
                actionId: createUuid(),
                actionType: "stopPause",
                blockingType: BlockingType.Hard,
            }],
        }, {
            onActionStateChanged: (actionState, withError, action, _agvId, state) => {
                actionStateInvocations++;
                ts.true(actionStateInvocations === 1 || actionStateInvocations === 2);
                if (actionStateInvocations === 1) {
                    ts.strictDeepEqual(action, actions.instantActions[0]);
                    ts.equal(withError, undefined);
                    ts.equal(actionState.actionId, actions.instantActions[0].actionId);
                    ts.equal(actionState.actionStatus, ActionStatus.Finished);
                    ts.equal(actionState.actionDescription, actions.instantActions[0].actionDescription);
                    ts.equal(actionState.resultDescription, "Paused");
                    ts.equal(state.paused, true);
                } else {
                    ts.strictDeepEqual(action, actions.instantActions[1]);
                    ts.equal(withError, undefined);
                    ts.equal(actionState.actionId, actions.instantActions[1].actionId);
                    ts.equal(actionState.actionStatus, ActionStatus.Finished);
                    ts.equal(actionState.actionDescription, actions.instantActions[1].actionDescription);
                    ts.equal(actionState.resultDescription, "Unpaused");
                    ts.equal(state.paused, false);
                    resolve();
                }
            },
            onActionError: () => {
                ts.fail("onActionError should never be called");
                resolve();
            },
        });
    }));

    await t.test("instant action orderExecutionTime", ts => new Promise(async resolve => {
        let actionStateInvocations = 0;
        const actions = await mcController.initiateInstantActions(agvId1, {
            instantActions: [{
                actionId: createUuid(),
                actionType: "orderExecutionTime",
                blockingType: BlockingType.None,
                actionParameters: [{ key: "orders", value: [createHeaderlessOrder()] }],
            }],
        }, {
            onActionStateChanged: (actionState, withError, action) => {
                actionStateInvocations++;
                ts.equal(actionStateInvocations, 1);
                ts.strictDeepEqual(action, actions.instantActions[0]);
                ts.equal(withError, undefined);
                ts.equal(actionState.actionId, actions.instantActions[0].actionId);
                ts.equal(actionState.actionStatus, ActionStatus.Finished);
                ts.equal(actionState.actionDescription, actions.instantActions[0].actionDescription);
                // Pick & Drop times: 2 * (5+5)s; edge traversal time: 50s
                ts.equal(parseFloat(actionState.resultDescription), 70);
                resolve();
            },
            onActionError: () => {
                ts.fail("onActionError should never be called");
                resolve();
            },
        });
    }));

    await t.test("instant actions startCharging-stopCharging", ts => new Promise(async resolve => {
        let actionStateInvocations = 0;
        const actions = await mcController.initiateInstantActions(agvId1, {
            instantActions: [{
                actionId: createUuid(),
                actionType: "startCharging",
                blockingType: BlockingType.Hard,
            }],
        }, {
            onActionStateChanged: async (actionState, withError, action, _agvId, state) => {
                actionStateInvocations++;
                ts.true(actionStateInvocations === 1 || actionStateInvocations === 2);
                ts.strictDeepEqual(action, actions.instantActions[0]);
                ts.equal(withError, undefined);
                ts.equal(actionState.actionId, actions.instantActions[0].actionId);
                ts.equal(actionState.actionDescription, actions.instantActions[0].actionDescription);
                ts.equal(actionState.actionStatus, actionStateInvocations === 1 ? ActionStatus.Running : ActionStatus.Finished);
                ts.equal(actionState.resultDescription, actionStateInvocations === 1 ? undefined : "Started charging");
                ts.equal(state.batteryState.charging, actionStateInvocations === 1 ? false : true);

                if (actionStateInvocations === 1) {
                    return;
                }

                const reachOnCharging = state.batteryState.reach;
                let stateChangesReceived = 0;
                let isStoppingCharging = false;
                await mcController.subscribe(Topic.State, agvId1, async (state1, _agvId1, _topic1, subscriptionId) => {
                    // Charge from 80% to 90% in 3.6s (with timeLapse 100). Approx. 10 state changes received.
                    stateChangesReceived++;

                    if (!isStoppingCharging && state1.batteryState.batteryCharge > 90) {
                        isStoppingCharging = true;
                        let actionStateInvocations1 = 0;
                        const actions1 = await mcController.initiateInstantActions(agvId1, {
                            instantActions: [{
                                actionId: createUuid(),
                                actionType: "stopCharging",
                                blockingType: BlockingType.Hard,
                            }],
                        }, {
                            onActionStateChanged: async (actionState1, withError1, action1, _agvId11, state11) => {
                                actionStateInvocations1++;
                                ts.true(actionStateInvocations1 === 1 || actionStateInvocations1 === 2);
                                ts.strictDeepEqual(action1, actions1.instantActions[0]);
                                ts.equal(withError1, undefined);
                                ts.equal(actionState1.actionId, actions1.instantActions[0].actionId);
                                ts.equal(actionState1.actionDescription, actions1.instantActions[0].actionDescription);
                                ts.equal(actionState1.actionStatus,
                                    actionStateInvocations1 === 1 ? ActionStatus.Running : ActionStatus.Finished);
                                ts.equal(actionState1.resultDescription,
                                    actionStateInvocations1 === 1 ? undefined : "Stopped charging");
                                ts.equal(state11.batteryState.charging, actionStateInvocations1 === 1 ? true : false);

                                if (actionStateInvocations1 === 2) {
                                    ts.true(stateChangesReceived >= 9);
                                    ts.true(state11.batteryState.reach - reachOnCharging >= 25920 - 23040);
                                    ts.true(state11.batteryState.reach - reachOnCharging <= 28800 - 23040);
                                    await mcController.unsubscribe(subscriptionId);
                                    resolve();
                                }
                            },
                            onActionError: () => {
                                ts.fail("onActionError should never be called");
                                resolve();
                            },
                        });
                    }
                });
            },
            onActionError: () => {
                ts.fail("onActionError should never be called");
                resolve();
            },
        });
    }));

    /* Order tests with rejection errors  */

    await testOrderError(t, "order invalid - not well-formed",
        ErrorType.OrderValidation,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: "o42",
            orderUpdateId: "foo",
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, actions: [] }],
            edges: [],
        } as unknown as Headerless<Order>,
        undefined,
        { referenceKey: "topic", referenceValue: Topic.Order },
        { referenceKey: "orderId", referenceValue: "o42" },
    );

    await testOrderError(t, "order invalid - nodes empty",
        ErrorType.OrderValidation,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: "o42",
            orderUpdateId: 0,
            nodes: [],
            edges: [],
        },
        undefined,
        { referenceKey: "topic", referenceValue: Topic.Order },
        { referenceKey: "orderId", referenceValue: "o42" },
    );

    await testOrderError(t, "order invalid - invalid node sequenceId",
        ErrorType.OrderValidation,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: "o42",
            orderUpdateId: 0,
            nodes: [{ nodeId: "n1", sequenceId: 1, released: true, actions: [] }],
            edges: [],
        },
        undefined,
        { referenceKey: "topic", referenceValue: Topic.Order },
        { referenceKey: "orderId", referenceValue: "o42" },
    );

    await testOrderError(t, "order invalid - invalid node horizon",
        ErrorType.OrderValidation,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: "o42",
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: false, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: true, nodePosition: { x: 0, y: 0, mapId: "local" }, actions: [] },
            ],
            edges: [{ edgeId: "e12", sequenceId: 1, startNodeId: "n1", endNodeId: "n2", released: true, actions: [] }],
        },
        undefined,
        { referenceKey: "topic", referenceValue: Topic.Order },
        { referenceKey: "orderId", referenceValue: "o42" },
    );

    await testOrderError(t, "order invalid - invalid number of edges",
        ErrorType.OrderValidation,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: "o42",
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: true, nodePosition: { x: 0, y: 0, mapId: "local" }, actions: [] },
            ],
            edges: [],
        },
        undefined,
        { referenceKey: "topic", referenceValue: Topic.Order },
        { referenceKey: "orderId", referenceValue: "o42" },
    );

    await testOrderError(t, "order invalid - invalid edge sequenceId",
        ErrorType.OrderValidation,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: "o42",
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: true, nodePosition: { x: 0, y: 0, mapId: "local" }, actions: [] },
            ],
            edges: [{ edgeId: "e12", sequenceId: 2, startNodeId: "n1", endNodeId: "n2", released: true, actions: [] }],
        },
        undefined,
        { referenceKey: "topic", referenceValue: Topic.Order },
        { referenceKey: "orderId", referenceValue: "o42" },
    );

    await testOrderError(t, "order invalid - invalid edge horizon",
        ErrorType.OrderValidation,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: "o42",
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: true, nodePosition: { x: 0, y: 0, mapId: "local" }, actions: [] },
            ],
            edges: [{ edgeId: "e12", sequenceId: 1, startNodeId: "n1", endNodeId: "n2", released: false, actions: [] }],
        },
        undefined,
        { referenceKey: "topic", referenceValue: Topic.Order },
        { referenceKey: "orderId", referenceValue: "o42" },
    );

    await testOrderError(t, "order invalid - invalid edge start end nodes",
        ErrorType.OrderValidation,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: "o42",
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: true, nodePosition: { x: 0, y: 0, mapId: "local" }, actions: [] },
            ],
            edges: [{ edgeId: "e12", sequenceId: 1, startNodeId: "n2", endNodeId: "n1", released: true, actions: [] }],
        },
        undefined,
        { referenceKey: "topic", referenceValue: Topic.Order },
        { referenceKey: "orderId", referenceValue: "o42" },
    );

    await testOrderError(t, "order invalid - incorrect mapId",
        ErrorType.OrderNoRoute,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, nodePosition: { x: 0, y: 0, mapId: "foo" }, actions: [] }],
            edges: [],
        },
        undefined,
        { referenceKey: "nodeId", referenceValue: "n1" },
        { referenceKey: "nodePosition.mapId", referenceValue: "local" },
    );

    await testOrderError(t, "order invalid - nodePosition missing",
        ErrorType.OrderNoRoute,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: true, actions: [] },
            ],
            edges: [
                { edgeId: "e12", sequenceId: 1, startNodeId: "n1", endNodeId: "n2", released: true, actions: [] },
            ],
        },
        undefined,
        { referenceKey: "nodeId", referenceValue: "n2" },
        { referenceKey: "nodePosition", referenceValue: "undefined" },
    );

    await testOrderError(t, "order invalid - first node not within deviation range",
        ErrorType.OrderNoRoute,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, nodePosition: { x: 1, y: 1, mapId: "local" }, actions: [] }],
            edges: [],
        },
        undefined,
        { referenceKey: "nodeId", referenceValue: "n1" },
        { referenceKey: "nodePosition.allowedDeviationXy", referenceValue: "0.5" },
    );

    await testOrderError(t, "order invalid - node action not supported",
        ErrorType.Order,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [
                {
                    nodeId: "n1", sequenceId: 0, released: true,
                    actions: [{ actionId: "a001", actionType: "puck", blockingType: BlockingType.Hard }],
                }],
            edges: [],
        },
        undefined,
        { referenceKey: "actionId", referenceValue: "a001" },
        { referenceKey: "actionType", referenceValue: "puck" },
    );

    await testOrderError(t, "order invalid - edge action not supported",
        ErrorType.Order,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: true, nodePosition: { x: 10, y: 10, mapId: "local" }, actions: [] },
            ],
            edges: [
                {
                    edgeId: "e12", sequenceId: 1, startNodeId: "n1", endNodeId: "n2", released: true,
                    actions: [{ actionId: "a001", actionType: "puck", blockingType: BlockingType.Hard }],
                },
            ],
        },
        undefined,
        { referenceKey: "actionId", referenceValue: "a001" },
        { referenceKey: "actionType", referenceValue: "puck" },
    );

    await testOrderError(t, "order invalid - missing action parameter",
        ErrorType.Order,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [
                {
                    nodeId: "n1", sequenceId: 0, released: true,
                    actions: [{ actionId: "a001", actionType: "pick", blockingType: BlockingType.Hard }],
                }],
            edges: [],
        },
        undefined,
        { referenceKey: "actionId", referenceValue: "a001" },
        { referenceKey: "actionType", referenceValue: "pick" },
        { referenceKey: "actionParameter", referenceValue: "stationType" },
    );

    await testOrderError(t, "order invalid - invalid action parameter",
        ErrorType.Order,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [
                {
                    nodeId: "n1", sequenceId: 0, released: true,
                    actions: [{
                        actionId: "a001", actionType: "drop", blockingType: BlockingType.Hard,
                        actionParameters: [
                            { key: "stationType", value: "high-rack" },
                            { key: "loadType", value: "EPAL" },
                        ],
                    }],
                }],
            edges: [],
        },
        undefined,
        { referenceKey: "actionId", referenceValue: "a001" },
        { referenceKey: "actionType", referenceValue: "drop" },
        { referenceKey: "actionParameter", referenceValue: "stationType" },
    );

    await testOrderError(t, "order not executable while charging",
        ErrorType.Order,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, actions: [] }],
            edges: [],
        },
        { ac: agvController1, keyChain: "batteryState.charging", newValue: true },
        { referenceKey: "batteryState.charging", referenceValue: "true" },
    );

    await testOrderError(t, "order not executable as emergency stop is active",
        ErrorType.Order,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, actions: [] }],
            edges: [],
        },
        { ac: agvController1, keyChain: "safetyState.eStop", newValue: "MANUAL" },
        { referenceKey: "safetyState.eStop", referenceValue: "MANUAL" },
    );

    await testOrderError(t, "order not executable due to protective field violation",
        ErrorType.Order,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, actions: [] }],
            edges: [],
        },
        { ac: agvController1, keyChain: "safetyState.fieldViolation", newValue: true },
        { referenceKey: "safetyState.fieldViolation", referenceValue: "true" },
    );

    await testOrderError(t, "order not executable due to operating mode",
        ErrorType.Order,
        mcControllerWithoutValidation,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, actions: [] }],
            edges: [],
        },
        { ac: agvController1, keyChain: "operatingMode", newValue: "SERVICE" },
        { referenceKey: "operatingMode", referenceValue: "SERVICE" },
    );


    /* Order execution tests */

    await testOrder(t, "execute new order with one base node",
        mcController,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, actions: [] }],
            edges: [],
        },
        { completes: true },
    );

    await testOrder(t, "execute new order with two base nodes",
        mcController,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: true, nodePosition: { x: 10, y: 10, mapId: "local" }, actions: [] },
            ],
            edges: [
                { edgeId: "e12", sequenceId: 1, startNodeId: "n1", endNodeId: "n2", released: true, actions: [] },
            ],
        },
        { completes: true },
    );

    await testOrder(t, "execute new cyclic order with three base nodes",
        mcController,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: true, nodePosition: { x: 10, y: 10, mapId: "local" }, actions: [] },
                { nodeId: "n1", sequenceId: 4, released: true, nodePosition: { x: 0, y: 0, mapId: "local" }, actions: [] },
            ],
            edges: [
                { edgeId: "e12", sequenceId: 1, startNodeId: "n1", endNodeId: "n2", released: true, actions: [] },
                { edgeId: "e21", sequenceId: 3, startNodeId: "n2", endNodeId: "n1", released: true, actions: [] },
            ],
        },
        { completes: true },
    );

    let lastOrderId = createUuid();

    await testOrder(t, "execute new order with one base node and one horizon node",
        mcController,
        agvId1,
        {
            orderId: lastOrderId,
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n2", sequenceId: 2, released: false, nodePosition: { x: 10, y: 10, mapId: "local" }, actions: [] },
            ],
            edges: [
                { edgeId: "e12", sequenceId: 1, startNodeId: "n1", endNodeId: "n2", released: false, actions: [] },
            ],
        },
        { completes: false },
    );

    await testOrder(t, "reject stitching order not extending active base node",
        mcController,
        agvId1,
        {
            orderId: lastOrderId,
            orderUpdateId: 1,
            nodes: [
                { nodeId: "n11", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n3", sequenceId: 2, released: true, nodePosition: { x: 20, y: 20, mapId: "local" }, actions: [] },
            ],
            edges: [
                { edgeId: "e113", sequenceId: 1, startNodeId: "n11", endNodeId: "n3", released: true, actions: [] },
            ],
        },
        {
            completes: true,
            errorRefs: [
                { referenceKey: "topic", referenceValue: Topic.Order },
                { referenceKey: "orderId", referenceValue: lastOrderId },
                { referenceKey: "orderUpdateId", referenceValue: "1" },
            ],
        },
    );

    await testOrder(t, "execute stitching order with one more base node and one horizon node",
        mcController,
        agvId1,
        {
            orderId: lastOrderId,
            orderUpdateId: 1,
            nodes: [
                { nodeId: "n1", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n3", sequenceId: 2, released: true, nodePosition: { x: 20, y: 20, mapId: "local" }, actions: [] },
                { nodeId: "n4", sequenceId: 4, released: false, nodePosition: { x: 30, y: 30, mapId: "local" }, actions: [] },
            ],
            edges: [
                { edgeId: "e13", sequenceId: 1, startNodeId: "n1", endNodeId: "n3", released: true, actions: [] },
                { edgeId: "e34", sequenceId: 3, startNodeId: "n3", endNodeId: "n4", released: false, actions: [] },
            ],
        },
        { completes: false },
    );

    await testOrder(t, "order discarded by mc - same orderId and orderUpdateId as active order",
        mcController,
        agvId1,
        {
            orderId: lastOrderId,
            orderUpdateId: 1,
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, actions: [] }],
            edges: [],
        },
        {
            discarded: true,
            completes: false,
        });

    lastOrderId = createUuid();
    await testOrder(t, "execute another stitching order with one more base node",
        mcController,
        agvId1,
        {
            // Use different orderId for stitching.
            orderId: lastOrderId,
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n3", sequenceId: 2, released: true, nodePosition: { x: 20, y: 20, mapId: "local" }, actions: [] },
                { nodeId: "n5", sequenceId: 4, released: true, nodePosition: { x: 30, y: 30, mapId: "local" }, actions: [] },
            ],
            edges: [
                { edgeId: "e35", sequenceId: 3, startNodeId: "n3", endNodeId: "n5", released: true, actions: [] },
            ],
        },
        { completes: true },
    );

    await testOrder(t, "reject order update not matching last base node",
        mcController,
        agvId1,
        {
            // Use same orderId and greater orderUpdateId.
            orderId: lastOrderId,
            orderUpdateId: 1,
            nodes: [
                { nodeId: "n51", sequenceId: 4, released: true, nodePosition: { x: 30, y: 30, mapId: "local" }, actions: [] },
                { nodeId: "n6", sequenceId: 6, released: true, nodePosition: { x: 0, y: 0, mapId: "local" }, actions: [] },
            ],
            edges: [
                { edgeId: "e516", sequenceId: 5, startNodeId: "n51", endNodeId: "n6", released: true, actions: [] },
            ],
        },
        {
            completes: true,
            errorRefs: [
                { referenceKey: "topic", referenceValue: Topic.Order },
                { referenceKey: "orderId", referenceValue: lastOrderId },
                { referenceKey: "orderUpdateId", referenceValue: "1" },
            ],
        },
    );

    await testOrder(t, "execute order update with one more base node",
        mcController,
        agvId1,
        {
            // Use same orderId and greater orderUpdateId.
            orderId: lastOrderId,
            orderUpdateId: 1,
            nodes: [
                { nodeId: "n5", sequenceId: 4, released: true, nodePosition: { x: 30, y: 30, mapId: "local" }, actions: [] },
                { nodeId: "n6", sequenceId: 6, released: true, nodePosition: { x: 0, y: 0, mapId: "local" }, actions: [] },
            ],
            edges: [
                { edgeId: "e56", sequenceId: 5, startNodeId: "n5", endNodeId: "n6", released: true, actions: [] },
            ],
        },
        { completes: true },
    );

    lastOrderId = createUuid();
    const dropAction = createPickDropAction("drop");
    await testOrder(t, "execute new order with failing drop action - no load to drop",
        mcController,
        agvId1,
        {
            orderId: lastOrderId,
            orderUpdateId: 0,
            nodes: [{ nodeId: "n1", sequenceId: 0, released: true, actions: [dropAction] }],
            edges: [],
        },
        {
            completes: true,
            actionErrorRefs: [
                { referenceKey: "topic", referenceValue: Topic.Order },
                { referenceKey: "actionId", referenceValue: dropAction.actionId },
            ],
        },
    );

    await testOrder(t, "execute order with pick and drop actions on one base node",
        mcController,
        agvId1,
        {
            orderId: lastOrderId,
            orderUpdateId: 1,
            nodes: [{
                nodeId: "n1", sequenceId: 0, released: true,
                actions: [createPickDropAction("pick"), createPickDropAction("drop")],
            }],
            edges: [],
        },
        { completes: true },
    );

    await testOrder(t, "execute new order with two base nodes and pick-drop actions",
        mcController,
        agvId1,
        {
            orderId: createUuid(),
            orderUpdateId: 0,
            nodes: [
                {
                    nodeId: "n1", sequenceId: 0, released: true,
                    actions: [createPickDropAction("pick")],
                },
                {
                    nodeId: "n2", sequenceId: 2, released: true, nodePosition: { x: 10, y: 10, mapId: "local" },
                    actions: [createPickDropAction("drop")],
                },
            ],
            edges: [
                { edgeId: "e12", sequenceId: 1, startNodeId: "n1", endNodeId: "n2", released: true, actions: [] },
            ],
        },
        { completes: true },
    );

    await testOrder(t, "execute new order with one base node and one horizon node to be canceled afterwards",
        mcController,
        agvId1,
        {
            orderId: lastOrderId,
            orderUpdateId: 0,
            nodes: [
                { nodeId: "n2", sequenceId: 0, released: true, actions: [] },
                { nodeId: "n1", sequenceId: 2, released: false, nodePosition: { x: 0, y: 0, mapId: "local" }, actions: [] },
            ],
            edges: [
                { edgeId: "e21", sequenceId: 1, startNodeId: "n2", endNodeId: "n1", released: false, actions: [] },
            ],
        },
        {
            completes: false,
        },
    );

    await t.test("instant action cancelOrder on active order", ts => new Promise(async resolve => {
        let changeInvocation = -1;
        const actions = await mcController.initiateInstantActions(agvId1, {
            instantActions: [{
                actionId: createUuid(),
                actionType: "cancelOrder",
                blockingType: BlockingType.Hard,
            }],
        }, {
            onActionStateChanged: (actionState, withError, action, agvId, state) => {
                changeInvocation++;
                if (changeInvocation > 1) {
                    ts.fail("unexpected actionStateChanged invocation");
                    resolve();
                    return;
                }
                ts.equal(actionState.actionStatus, changeInvocation === 0 ? ActionStatus.Running : ActionStatus.Finished);
                ts.strictDeepEqual(agvId, agvId1);
                ts.notEqual(actions.instantActions.indexOf(action), -1);
                ts.equal(withError, undefined);

                if (actionState.actionStatus === ActionStatus.Finished) {
                    ts.pass("cancelOrder finished");
                    resolve();
                } else if (actionState.actionStatus === ActionStatus.Failed) {
                    ts.fail("cancelOrder should not have failed");
                    resolve();
                }
            },
            onActionError: () => {
                ts.fail("onActionError should never be called");
                resolve();
            },
        });
    }));

    /* @todo Add more tests
     *
     * - cancel active order with active actions
     * - startCharging - startPause - stopPause
     */

});
