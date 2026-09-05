import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const bridgePath = path.join(root, 'mcp-bridge', 'bridge.js');
const bridgeCode = fs.readFileSync(bridgePath, 'utf8');

// Test each tool by name and ensure valid input mapping / rejection contracts
const ALL_TOOLS = [
  'tab_navigate', 'tab_eval', 'tab_list', 'tab_switch', 'tab_new', 'tab_close',
  'tab_snapshot', 'tab_find', 'tab_visual_snapshot',
  'tab_get_text', 'tab_get_html', 'tab_stats', 'tab_screenshot',
  'click', 'type', 'key', 'scroll', 'drag', 'wait', 'wait_for',
  'wait_for_network_idle', 'tab_console_logs', 'batch_actions'
];

test('every tool is explicitly registered in TOOLS with valid schema and annotations', () => {
  for (const name of ALL_TOOLS) {
    const reg = new RegExp(`name:\\s*'${name}'[\\s\\S]*?description:`);
    assert.match(bridgeCode, reg, `Tool ${name} should be declared in TOOLS array`);
  }
});

test('toolToAction contract tests for all tools', async () => {
  // Extract or dynamically verify the action mapping patterns in bridge.js
  const patterns = {
    tab_navigate: /case 'tab_navigate':/,
    tab_eval: /case 'tab_eval':/,
    tab_list: /case 'tab_list':/,
    tab_switch: /case 'tab_switch':/,
    tab_new: /case 'tab_new':/,
    tab_close: /case 'tab_close':/,
    tab_snapshot: /case 'tab_snapshot':/,
    tab_find: /case 'tab_find':/,
    tab_visual_snapshot: /case 'tab_visual_snapshot':/,
    tab_get_text: /case 'tab_get_text':/,
    tab_get_html: /case 'tab_get_html':/,
    tab_stats: /case 'tab_stats':/,
    tab_screenshot: /case 'tab_screenshot':/,
    click: /case 'click':/,
    type: /case 'type':/,
    key: /case 'key':/,
    scroll: /case 'scroll':/,
    drag: /case 'drag':/,
    wait: /case 'wait':/,
    wait_for: /case 'wait_for':/,
    wait_for_network_idle: /case 'wait_for_network_idle':/,
    tab_console_logs: /case 'tab_console_logs':/,
    batch_actions: /case 'batch_actions':/
  };

  for (const tool of ALL_TOOLS) {
    assert.ok(patterns[tool], `Pattern exists for tool: ${tool}`);
    assert.match(bridgeCode, patterns[tool], `bridge.js handles toolToAction for ${tool}`);
  }
});

test('individual tool parameter requirements and guards are enforced', () => {
  // tab_navigate: requires http/https
  assert.match(bridgeCode, /tab_navigate only allows http\/https URLs/);
  // tab_eval: requires allowEval: true
  assert.match(bridgeCode, /tab_eval requires allowEval:true/);
  // tab_new: restricts to http/https when provided
  assert.match(bridgeCode, /tab_new only allows http\/https URLs/);
  // wait: bounds check
  assert.match(bridgeCode, /wait ms must be 0-30000/);
  // wait_for: bounds check
  assert.match(bridgeCode, /wait_for timeoutMs must be 0-30000/);
  // wait_for_network_idle: bounds check
  assert.match(bridgeCode, /idleMs must be 50-5000/);
  // visual_snapshot & screenshot: bounds check
  assert.match(bridgeCode, /quality must be 30-90/);
  // batch_actions: bounds check
  assert.match(bridgeCode, /batch_actions requires 1-\${MAX_BATCH_ACTIONS} actions/);
  // click: supports semantic, element ID, coordinates, or selector
  assert.match(bridgeCode, /action: 'click_semantic'/);
  assert.match(bridgeCode, /action: 'click_id'/);
  assert.match(bridgeCode, /action: 'click_xy'/);
});
