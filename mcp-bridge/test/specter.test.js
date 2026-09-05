import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const bridge = fs.readFileSync(path.join(root, 'mcp-bridge', 'bridge.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

// Contract-level smoke tests: these run without Chrome and protect the
// security/safety invariants that are easy to regress during refactors.
test('eval requires explicit consent', () => {
  assert.match(bridge, /allowEval:true/);
  assert.match(background, /job\.allowEval !== true/);
});

test('target closure fails closed and jobs serialize', () => {
  assert.match(background, /targetInvalidated/);
  assert.match(background, /Target tab was closed; explicitly select/);
  assert.match(background, /runSerialized/);
});

test('frame-aware messaging and all-frame injection are present', () => {
  assert.match(background, /frameIds: \[0\]/);
  assert.match(background, /frameId: msg\.frameId/);
});

test('coordinate clicks reject empty or disabled targets', () => {
  assert.match(content, /No clickable element at/);
  assert.match(content, /Target element is disabled/);
});

test('DOM inspection caches are short-lived and traversal is bounded', () => {
  assert.match(content, /DOM_QUERY_CACHE_MS/);
  assert.match(content, /SNAPSHOT_CACHE_MS/);
  assert.match(content, /MAX_TRAVERSAL_NODES/);
  assert.match(content, /observedRoots/);
  assert.match(content, /inspectionContext/);
});

test('new tools are exposed', () => {
  assert.match(bridge, /name: 'tab_find'/);
  assert.match(bridge, /name: 'tab_visual_snapshot'/);
  assert.match(bridge, /name: 'wait_for_network_idle'/);
  assert.match(bridge, /name: 'tab_console_logs'/);
  assert.match(background, /case 'wait_for_network_idle'/);
  assert.match(background, /case 'console_logs'/);
  assert.match(content, /waitForNetworkIdle/);
  assert.match(content, /getConsoleLogs/);
});

test('all tools have complete readOnlyHint, destructiveHint, idempotentHint, and openWorldHint annotations', () => {
  const toolsMatch = bridge.match(/const TOOLS = (\[[\s\S]*?\]);/);
  assert.ok(toolsMatch, 'TOOLS array found in bridge.js');
  // Simple validation to ensure all tools have hints defined
  const hints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
  const allToolNames = [
    'tab_navigate', 'tab_eval', 'tab_list', 'tab_switch', 'tab_new', 'tab_close',
    'tab_snapshot', 'tab_find', 'tab_visual_snapshot',
    'tab_get_text', 'tab_get_html', 'tab_stats', 'tab_screenshot',
    'click', 'type', 'key', 'scroll', 'drag', 'wait', 'wait_for',
    'wait_for_network_idle', 'tab_console_logs', 'batch_actions'
  ];
  for (const name of allToolNames) {
    assert.match(bridge, new RegExp(`name:\\s*'${name}'`));
  }
  for (const hint of hints) {
    const hintCount = (bridge.match(new RegExp(`${hint}:\\s*(true|false)`, 'g')) || []).length;
    assert.equal(hintCount, allToolNames.length, `Expected all tools to declare ${hint}`);
  }
});

test('batch actions are bounded, allowlisted, serialized, and report stop state', () => {
  assert.match(bridge, /name: 'batch_actions'/);
  assert.match(bridge, /MAX_BATCH_ACTIONS = 50/);
  assert.match(bridge, /BATCH_TOOLS/);
  assert.match(bridge, /stopOnError/);
  assert.match(bridge, /wait_for_network_idle/);
  assert.match(bridge, /tab_console_logs/);
  assert.match(background, /case 'batch_actions'/);
  assert.match(background, /BATCH_ACTIONS/);
  assert.match(background, /stoppedAt/);
  assert.match(background, /source: 'internal'/);
  assert.match(background, /child\.batchTool \|\| child\.action/);
});

test('batched child actions preserve explicit frame routing', () => {
  assert.match(bridge, /action: 'click_xy', x: args\.x, y: args\.y, frameId: args\.frameId/);
  assert.match(bridge, /action: 'type', selector: args\.selector, element: parsedId, text: args\.text, frameId: args\.frameId/);
  assert.match(background, /type: 'CURSOR_TYPE', selector: job\.selector, element: job\.element, text: job\.text, frameId: job\.frameId/);
  assert.match(background, /waitForSelector\(job\.selector, job\.timeoutMs \?\? 10000, job\.frameId\)/);
  assert.match(bridge, /frameId must be a non-negative integer/);
  assert.match(background, /Invalid frameId at batch action index/);
});

test('WSS transport has reliability and bounded-queue contracts', () => {
  assert.match(bridge, /WSS_HEARTBEAT_MS/);
  assert.match(bridge, /\.ping\(\)/);
  assert.match(bridge, /WSS_ACK_TIMEOUT/);
  assert.match(bridge, /queueForFailover/);
  assert.match(bridge, /MAX_QUEUE_BYTES/);
  assert.match(bridge, /wsHealthy/);
  assert.match(bridge, /type: 'ack'/);
  assert.match(background, /WSS_RETRY_MAX_MS/);
  assert.match(background, /wssRetryMs \* 2/);
  assert.match(background, /stopPolling\(\)/);
  assert.match(background, /startPolling\(\)/);
  assert.match(background, /type: 'pong'/);
});
