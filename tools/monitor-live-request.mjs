// 真实请求监控 — 通过 Helix Router 发多轮,采集两边日志
const KEY = 'sk-ccr-fHKHe4xgySeOrkHia9OmFh2uze4KYN3eA8ULPANrMBU';
const SUFFIX = `${Date.now().toString(36)}-live`;

const topics = [
  ['Redis Cluster slot 分配', 'Redis Cluster 使用 16384 个 slot 进行数据分片。每个 key 经 CRC16 算法映射到一个 slot。节点通过 gossip 协议维护状态,主从复制保证高可用,Raft-like 协议选举新 master。客户端用 MOVED 重定向访问正确节点。'],
  ['Kafka offset 提交策略', '每个 partition 在消费者组内是独占消费的。每条消息有唯一 offset,消费者提交 offset 记录消费进度。支持自动提交和手动提交。事务场景用 read_committed isolation level。消费者组通过 Coordinator 协调分区分配。'],
  ['Docker overlay 网络', 'Docker overlay 网络用 VXLAN 封装二层帧,通过 UDP 在跨主机 IP 网络上传输。底层依赖 etcd 存储集群网络状态。Macvlan 让容器直接暴露为物理网络设备。'],
  ['k8s kube-scheduler 算法', 'kube-scheduler 用两阶段调度:Predicate 预选(资源、端口、亲和性、污点容忍)和 Priority 优选(基于空闲资源、镜像本地性等权重)。高优先级 Pod 通过抢占机制驱逐低优先级 Pod。'],
  ['etcd Raft 一致性', 'etcd 基于 Raft 算法实现强一致性。leader 处理所有写,通过日志复制和过半确认保证 commit。MVCC 用 revision 维护多版本,lease 实现分布式锁。'],
  ['MongoDB 副本集选举', 'MongoDB 副本集基于 Raft 选举,过半票数生效。secondary 通过 oplog 重放追赶 primary。读偏好 5 种:primary/primaryPreferred/secondary/secondaryPreferred/nearest。wtimeout 控制写关注超时。'],
];

const messages = [];
for (let i = 0; i < topics.length; i++) {
  const [title, body] = topics[i];
  messages.push({
    role: 'user',
    content: `[${SUFFIX}] 详细解释 ${title},覆盖核心机制、实现细节、常见场景、生产实践中的监控告警策略、容量规划方法,字数尽量多一些。`.repeat(2)
  });
  messages.push({
    role: 'assistant',
    content: `好的,关于 ${title},核心内容:${body} \n\n关键要点:${body.repeat(2).substring(0, 800)}\n\n详细展开:${body.repeat(3)}\n\n行业最佳实践:监控系统需覆盖关键指标、容量规划需提前评估、定期演练故障切换。`.repeat(2)
  });
}
messages.push({ role: 'user', content: `[${SUFFIX}] 综合上面 6 个讨论,给出每个主题的核心要点,关键常量(如 16384、partition 数等)和术语,以及它们之间的对比。` });

const totalChars = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
console.log(`=== [${SUFFIX}] 端到端真实请求监控 ===`);
console.log(`消息数: ${messages.length},总字符: ${totalChars}`);

// 时间戳
const tStart = Date.now();

// 实际请求(通过 Helix Router → plugin → helix-compressor → M3)
const r = await fetch('http://127.0.0.1:3456/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'MiniMax-M3', messages, max_tokens: 1500 })
});

const tEnd = Date.now();
const clientMs = tEnd - tStart;

const d = await r.json();
const choice = d.choices?.[0] || {};

// Show client-side response headers
const responseHeaders = {};
for (const [k, v] of r.headers.entries()) responseHeaders[k] = v;

console.log(`\n=== 客户端响应 ===`);
console.log('status:', r.status);
console.log('client-side latency:', clientMs, 'ms');
console.log('usage:', JSON.stringify(d.usage));
console.log('content length:', choice.message?.content?.length || 0);

// 关键 headers
const helixHdr = {};
for (const [k, v] of Object.entries(responseHeaders)) {
  if (k.startsWith('x-helix')) helixHdr[k] = v;
}
console.log('helix-compressor headers in client response:', JSON.stringify(helixHdr, null, 2));

// Save result
import { writeFileSync } from 'node:fs';
const out = {
  timestamp: new Date().toISOString(),
  suffix: SUFFIX,
  total_messages: messages.length,
  total_input_chars: totalChars,
  client_latency_ms: clientMs,
  status: r.status,
  usage: d.usage,
  helix_headers: helixHdr,
  content_preview: choice.message?.content?.substring(0, 800) || ''
};
writeFileSync('live-request-monitor-result.json', JSON.stringify(out, null, 2));
console.log('\nsaved live-request-monitor-result.json');
