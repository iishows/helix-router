// 端到端压缩率实测 - 用随机内容避免 LLM 缓存
const KEY = 'sk-ccr-fHKHe4xgySeOrkHia9OmFh2uze4KYN3eA8ULPANrMBU';
const SUFFIX = Date.now().toString(36);  // unique per run

const topics = [
  ['Apache Kafka 分区机制', 'Kafka Topic 由 partition 组成,每个 partition 是 append-only 日志。Producer 按策略(轮询/key hash/custom)选择 partition。Consumer Group 通过 Coordinator 进行 Rebalance 协议,确保每个 partition 被 group 内一个 consumer 独占消费。Offset 由 consumer 维护,支持回溯重放。EOS 通过事务协调器 + 幂等生产者实现,事务状态写入 __transaction_state 内部主题。'],
  ['PostgreSQL MVCC 机制', 'MVCC 通过 xmin/xmax 系统列和隐藏字段实现。Tuple 新增时不直接 UPDATE,而是 COPY-on-WRITE 写入新版本并在原 tuple 上标记 xmax。VACUUM 在后台回收 dead tuples。快照通过 pg_snapshot_xmin + active xid 集合判断版本可见性。REPEATABLE READ 用整个事务的快照,READ COMMITTED 用每条 SQL 的快照。Hot updates 走 heap-only tuple 减少 I/O。'],
  ['Linux 内核 epoll', 'epoll 是 Linux 2.6+ 的可扩展 I/O 多路复用机制。核心数据结构是红黑树(fd→struct) + 就绪链表(rdllist)。epoll_wait 通过 ep_poll_callback 把就绪 fd 加入 rdllist,LT 与 ET 模式:LT 持续通知直到被消费,ET 仅在状态变化时通知一次(必须非阻塞读直到 EAGAIN)。epoll_ctl 注册 fd 时用 RB_INSERT + eppoll_entry 链表头插入。'],
  ['OAuth 2.0 授权流程', 'OAuth 2.0 有 4 种 grant type:Authorization Code(with PKCE)、Client Credentials、Implicit(已弃用)、Resource Owner Password(已弃用)。Authorization Code 流程:用户同意 → 重定向带 code → 后端用 code + client_secret 换 access_token。PKCE 防 code 拦截攻击:client 生成 code_verifier + code_challenge,授权请求带 challenge,换 token 时给 verifier。Refresh Token 通过 rotation 检测重复使用。'],
];

// Build 12-turn conversation with UNIQUE suffix per content
const messages = [];
for (let i = 0; i < 12; i++) {
  const [title, body] = topics[i % topics.length];
  messages.push({ role: 'user', content: `[${SUFFIX}-${i}] 用户问:详细说明 ${title},这是第 ${i+1} 轮测试。` + body.substring(0, 200) + ' [end-of-' + SUFFIX + '-' + i + ']' });
  messages.push({ role: 'assistant', content: `[${SUFFIX}-${i}-A] 这是助手对 ${title} 的回答。` + body.substring(0, 250) + ' [end-' + SUFFIX + '-' + i + '-A]' });
}
messages.push({ role: 'user', content: `[${SUFFIX}-final] 综合上面 12 轮,列出每个主题核心要点与它们之间的关联。` });

console.log(`=== Test run ${SUFFIX} ===`);
console.log('Total messages:', messages.length);
const totalChars = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
console.log('Total chars:', totalChars);

// Baseline: 直接 curl Helix Router 看 input_tokens
console.log('\n=== A) Baseline 直接 curl Helix Router ===');
const r1 = await fetch('http://127.0.0.1:3456/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'MiniMax-M3', messages, max_tokens: 800 })
});
const d1 = await r1.json();
console.log('status:', r1.status);
console.log('usage:', JSON.stringify(d1.usage));
console.log('content length:', d1.choices?.[0]?.message?.content?.length || 0);

// B) Plugin 介入 — 同样的 messages 经过 Helix Router (plugin transform 应触发)
// 由于这个调用与 A 同 URL, 会被 Helix Router 同样的插件路径处理。
// 我们无法轻松禁用 plugin,所以 B 与 A 实际是同样的代码路径。
// 关键看 plugin 是否把 messages 切小 (compressCount > 0 → LLm 收到更小输入 → tokens 更少)

// C) 直接打 helix-compressor 看压缩结果
console.log('\n=== C) 直打 helix-compressor 看压缩结果 ===');
const r2 = await fetch('http://127.0.0.1:7788/v1/compress', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer hk_live_f790ca7c91dfe957bded77e93866d7e23146c53d8ab88258', 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages, model: 'MiniMax-M3', request_id: SUFFIX })
});
const d2 = await r2.json();
console.log('compress:', JSON.stringify(d2.stats));
console.log('hashMap entries:', Object.keys(d2.hashMap || {}).length);
console.log('any qMedia stored:', Object.values(d2.hashMap || {}).some(e => e.qMedia));

console.log('\n=== D) 看 compressed messages 输出 ===');
let originalLen = 0;
let compressedLen = 0;
for (let i = 0; i < d2.compressed.length; i++) {
  const m = d2.compressed[i];
  const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  compressedLen += c.length;
  if (typeof m.content === 'string' && m.content.includes('⟦QA:')) {
    console.log(`  [${i}] PLACEHOLDER: ${m.content.substring(0, 80)}`);
  } else if (typeof m.content === 'string') {
    console.log(`  [${i}] ${m.role}: ${m.content.substring(0, 80)}`);
  }
}
for (const m of messages) {
  originalLen += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
}
console.log(`消息层: 原始 ${originalLen} → 压缩 ${compressedLen} (降幅 ${((1 - compressedLen / originalLen) * 100).toFixed(2)}%)`);

// E) Predict B's input_tokens = should be similar to compressedLen-based estimate
const estCompressedTokens = Math.round(compressedLen / 3.5);
console.log(`\n预测: LLM 实际收到 ≈ ${estCompressedTokens} tokens (按 ~3.5 char/token 估算)`);
console.log(`Actual: Baseline A 收到 ${d1.usage?.prompt_tokens} tokens`);
console.log(`Delta: ${(d1.usage?.prompt_tokens || 0) - estCompressedTokens > 0 ? '+' : ''}${((d1.usage?.prompt_tokens || 0) - estCompressedTokens)} tokens(差异可能源于 image/cache/tool schema 等额外开销)`);
