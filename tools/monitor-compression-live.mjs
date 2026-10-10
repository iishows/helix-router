// Live test: send content that DOES trigger compression,verify x-helix-compressor-* stats in client response
const KEY = 'sk-ccr-fHKHe4xgySeOrkHia9OmFh2uze4KYN3eA8ULPANrMBU';
const SUFFIX = `${Date.now().toString(36)}-cmp`;

const longUserText = '请详细分析这张图里有什么。要求看清颜色、位置、坐标、标签、像素分布、视觉对比度、颜色直方图、所有视觉元素的具体细节、与上一张图的差异。字数尽量多一些。完整描述图里所有视觉元素、层级、空间关系。'.repeat(8);

const messages = [
  { role: 'user', content: [
    { type: 'text', text: longUserText + ' 图 1:折线图。' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgA'.repeat(60) } }
  ]},
  { role: 'assistant', content: '这是第一个回答,详细分析了这张小图。颜色编码:蓝色圆形 logo、白色背景、坐标位置居中、半径 30px。完整描述图里所有视觉元素、层级、空间关系。'.repeat(15) },
  { role: 'user', content: [
    { type: 'text', text: longUserText + ' 图 2:饼图。' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ'.repeat(600) } }
  ]},
  { role: 'assistant', content: '这是第二个回答,详细分析了这张图。占比:产品 A 45%,产品 B 30%,产品 C 15%,Other 10%。颜色:蓝/橙/绿/灰。详细描述完整覆盖。'.repeat(15) },
  { role: 'user', content: '这是第三轮 prompt,问 PDF §3 安全架构。' + longUserText },
  { role: 'assistant', content: 'PDF §3 安全架构详细综述:边缘 WAF、内网 mTLS、字段级 AES、KMS 自动轮转。这 4 层防护的具体落地、失败模式、监控指标,以及与公司 compliance 框架的映射关系。'.repeat(15) },
  { role: 'user', content: `[${SUFFIX}] 综合前面 3 轮,给出每张图的核心要点和数字,与前述对照。` }
];

console.log(`=== [${SUFFIX}] 端到端压缩触发 + 实时监控 ===`);
const startTime = Date.now();

const r = await fetch('http://127.0.0.1:3456/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'MiniMax-M3', messages, max_tokens: 1500 })
});

const totalMs = Date.now() - startTime;
const d = await r.json();

console.log('status:', r.status);
console.log('latency:', totalMs, 'ms');
console.log('usage:', JSON.stringify(d.usage));

// extract helix headers
const helixHdr = {};
for (const [k, v] of r.headers.entries()) {
  if (k.startsWith('x-helix')) helixHdr[k] = v;
}
console.log('\nx-helix-compressor-* headers in client response:');
for (const [k, v] of Object.entries(helixHdr)) {
  console.log(`  ${k}: ${v}`);
}

// Validation: 期待至少 qa-compressed > 0 + ratio > 0 + input-chars > output-chars
const qaCompressed = parseInt(helixHdr['x-helix-compressor-qa-compressed'] || '0', 10);
const ratio = parseFloat(helixHdr['x-helix-compressor-ratio'] || '0');
const inputChars = parseInt(helixHdr['x-helix-compressor-input-chars'] || '0', 10);
const outputChars = parseInt(helixHdr['x-helix-compressor-output-chars'] || '0', 10);
const saved = inputChars > outputChars ? inputChars - outputChars : 0;
const savedPct = inputChars > 0 ? (saved / inputChars * 100).toFixed(2) : 0;
console.log('\n=== 端到端压缩验证 ===');
console.log(`  压缩对: ${qaCompressed}`);
console.log(`  ratio: ${ratio}`);
console.log(`  input chars: ${inputChars}`);
console.log(`  output chars: ${outputChars}`);
console.log(`  saved: ${saved} chars (${savedPct}%)`);
console.log(`  scenario: ${helixHdr['x-helix-compressor-scenario'] || ''}`);
console.log(`  prompt_tokens: ${d.usage?.prompt_tokens} (LLM 实际收到)`);
console.log(`  content length: ${d.choices?.[0]?.message?.content?.length || 0}`);

// Save result
import { writeFileSync } from 'node:fs';
writeFileSync('live-compression-result.json', JSON.stringify({
  suffix: SUFFIX,
  latency_ms: totalMs,
  status: r.status,
  usage: d.usage,
  helix_headers: helixHdr,
  validation: { qaCompressed, ratio, inputChars, outputChars, saved, savedPct }
}, null, 2));
console.log('\nsaved live-compression-result.json');
