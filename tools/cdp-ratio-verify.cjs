const http = require('node:http');
const fs = require('node:fs');
const { WebSocket } = require('ws');

const CDP_HTTP = 'http://127.0.0.1:9222';
const GATEWAY = 'http://127.0.0.1:3456';
const CCR_KEY = 'sk-ccr-fHKHe4xgySeOrkHia9OmFh2uze4KYN3eA8ULPANrMBU';

let nextId = 1;
function cdpRpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error('CDP timeout: ' + method)), 30000);
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        if (msg.error) reject(new Error('CDP error: ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function newTab(url = 'about:blank') {
  const resp = await fetch(CDP_HTTP + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  return (await resp.json()).webSocketDebuggerUrl;
}

async function main() {
  console.log('[cdp-ratio] connecting to CDP...');
  const wsUrl = await newTab('about:blank');
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.on('open', r));
  await cdpRpc(ws, 'Page.enable');
  await cdpRpc(ws, 'Network.enable');
  await cdpRpc(ws, 'Runtime.enable');

  // 12-turn conversation with image block in middle (turn 2)
  const longUserText = '请详细解释这个图表。要求看清坐标、刻度、标签、颜色编码、单位、数值范围、趋势变化、关键数据点、视觉对比关系。'.repeat(5);
  const longAssistantText = '这是详细回答,覆盖所有视觉细节与上下文分析。我看到这张图里有以下几个关键特征:坐标系采用对数刻度、颜色编码使用 RGB 调色板、趋势线呈现稳定上升。该图表回答了用户的关键问题并提供了详细的视觉解读。'.repeat(15);
  const messages = [];
  for (let i = 0; i < 12; i++) {
    if (i === 2) {
      // Turn 3 用户上传一张图
      messages.push({ role: 'user', content: [
        { type: 'text', text: longUserText + '第 ' + (i+1) + ' 张图。' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAA'.repeat(800) } }
      ]});
    } else {
      messages.push({ role: 'user', content: 'Turn ' + i + ' 用户提问 ' + longUserText });
      messages.push({ role: 'assistant', content: longAssistantText });
    }
  }
  messages.push({ role: 'user', content: '总结前面 12 个讨论的核心要点,400 字以上。' });

  const totalInputChars = messages.reduce((s, m) => {
    if (typeof m.content === 'string') return s + m.content.length;
    return s + m.content.filter(b => b.text).reduce((a, b) => a + (b.text?.length || 0), 0);
  }, 0);
  console.log('[cdp-ratio] total input text chars:', totalInputChars);
  console.log('[cdp-ratio] total messages:', messages.length);

  console.log('[cdp-ratio] sending fetch...');
  const fetchResult = await cdpRpc(ws, 'Runtime.evaluate', {
    expression: `
      fetch('${GATEWAY}/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ${CCR_KEY}', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'MiniMax-M3', messages: ${JSON.stringify(messages)}, max_tokens: 1500 })
      }).then(async r => {
        const hdrs = {};
        for (const [k, v] of r.headers.entries()) hdrs[k] = v;
        const data = await r.json();
        return JSON.stringify({ status: r.status, headers: hdrs, usage: data.usage, content: data.choices?.[0]?.message?.content?.substring(0, 1000) || '' });
      }).catch(e => 'ERR:' + e.message)
    `,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000
  });

  if (!fetchResult.result?.value) { console.error('no result', fetchResult); process.exit(1); }

  let parsed;
  try { parsed = JSON.parse(fetchResult.result.value); }
  catch (e) { console.error('parse err:', fetchResult.result.value?.substring(0, 200)); process.exit(1); }

  // Collect helix headers
  const helixHeaders = {};
  for (const [k, v] of Object.entries(parsed.headers || {})) {
    if (k.startsWith('x-helix')) helixHeaders[k] = v;
  }
  console.log('\n[cdp-ratio] === 端到端压缩测试结果 ===');
  console.log('[cdp-ratio] status:', parsed.status);
  console.log('[cdp-ratio] usage:', JSON.stringify(parsed.usage));
  console.log('[cdp-ratio] helix headers in client response:', JSON.stringify(helixHeaders, null, 2));
  console.log('[cdp-ratio] content (first 800):');
  console.log((parsed.content || '').substring(0, 800));

  fs.writeFileSync('cdp-ratio-verify-result.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    test_messages: messages.length,
    total_input_text_chars: totalInputChars,
    status: parsed.status,
    usage: parsed.usage,
    helix_headers: helixHeaders,
    content_preview: parsed.content
  }, null, 2));
  console.log('[cdp-ratio] saved cdp-ratio-verify-result.json');

  ws.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
