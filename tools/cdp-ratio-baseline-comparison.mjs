// baseline 不通过 Helix Router plugin,直接 curl 看 input_tokens
const KEY = 'sk-ccr-fHKHe4xgySeOrkHia9OmFh2uze4KYN3eA8ULPANrMBU';

const longUserText = '请详细解释这个图表。要求看清坐标、刻度、标签、颜色编码、单位、数值范围、趋势变化、关键数据点、视觉对比关系。'.repeat(5);
const longAssistantText = '这是详细回答,覆盖所有视觉细节与上下文分析。我看到这张图里有以下几个关键特征:坐标系采用对数刻度、颜色编码使用 RGB 调色板、趋势线呈现稳定上升。该图表回答了用户的关键问题并提供了详细的视觉解读。'.repeat(15);
const messages = [];
for (let i = 0; i < 12; i++) {
  if (i === 2) {
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

const totalChars = messages.reduce((s, m) => {
  if (typeof m.content === 'string') return s + m.content.length;
  return s + m.content.filter(b => b.text).reduce((a, b) => a + (b.text?.length || 0), 0);
}, 0);
console.log('total text input chars:', totalChars);
console.log('total messages:', messages.length);

console.log('\n=== Baseline: 直接 curl 不走 plugin (no compression) ===');
const r = await fetch('http://127.0.0.1:3456/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'MiniMax-M3', messages, max_tokens: 1500 })
});
const d = await r.json();
console.log('status:', r.status);
console.log('usage:', JSON.stringify(d.usage));
console.log('finish_reason:', d.choices?.[0]?.finish_reason);
console.log('content length:', d.choices?.[0]?.message?.content?.length || 0);

// headers
console.log('--- response headers ---');
for (const [k, v] of r.headers.entries()) {
  console.log(' ', k + ':', (typeof v === 'string' ? v.substring(0, 200) : v));
}
