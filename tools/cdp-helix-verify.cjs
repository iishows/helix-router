/**
 * CDP 实测验收 — Helix Router 多轮压缩 + history_recall
 *
 * 用 Helix Router 自己的 Chrome 实例(CDP @9222),在新标签里跑 fetch:
 *   1. 拿 token(如有 cookie/JWT)
 *   2. 多轮对话 POST 到 127.0.0.1:3456
 *   3. 解析响应 headers 中的 x-helix-compressor-qa-compressed
 *   4. 验证 LLM 是否在最终响应里能复现历史 Q&A 信息(等于或劣于原内容)
 *
 * 输出:json (screenshots saved in cdp-shots/)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');

const CDP_HTTP = 'http://127.0.0.1:9222';
const GATEWAY = 'http://127.0.0.1:3456';
const CCR_KEY = 'sk-ccr-fHKHe4xgySeOrkHia9OmFh2uze4KYN3eA8ULPANrMBU';

function listPages() {
  return new Promise((resolve, reject) => {
    http.get(CDP_HTTP + '/json', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

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
  console.log('[cdp-helix-verify] connecting to CDP...');
  const wsUrl = await newTab('about:blank');
  console.log('[cdp-helix-verify] tab url:', wsUrl);
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.on('open', r));
  await cdpRpc(ws, 'Page.enable');
  await cdpRpc(ws, 'Network.enable');
  await cdpRpc(ws, 'Runtime.enable');
  await cdpRpc(ws, 'Page.navigate', { url: 'http://127.0.0.1:3456/' });
  // Wait for navigation
  await new Promise((r) => setTimeout(r, 2000));

  // User topics (diverse content to trigger compression)
  const userTopics = [
    ['Redis Cluster 集群方案', 'Redis Cluster 使用 16384 个 slot 进行数据分片,通过 gossip 协议在节点间同步状态。当 master 节点故障时,通过 Raft-like 协议在 slave 中选举新 master。客户端通过 MOVED 重定向访问正确节点。slot 迁移通过渐进式搬迁,迁移期间客户端会收到 ASK 错误。批量操作必须落在同一 slot。'],
    ['Kafka 分区机制', 'Kafka 的每个 Topic 被划分为多个分区,分布在不同 Broker 上。每个分区是一个有序不可变的消息序列,新消息追加到末尾,每条消息有唯一 offset。生产者根据分区策略选择目标分区。消费者组通过协调器协调分区分配。Exactly-Once 通过事务协调器 + 幂等生产者实现。'],
    ['Docker 网络模式', 'Docker 容器网络有四种模式:bridge、host、none、container。跨主机通信使用 overlay 网络,通过 VXLAN 隧道封装。Macvlan 让容器直接暴露为物理网络的设备,获得独立的 MAC 和 IP 适合对延迟敏感或需要直接对外暴露的场景。'],
    ['Kubernetes 调度', 'kube-scheduler 是 K8s 默认调度器,采用两阶段调度:Predicate 预选过滤候选节点(检查 CPU/内存、端口、NodeSelector、亲和性、污点容忍、Taints 等约束条件);Priority 优选对通过预选的节点打分,最终选出得分最高的节点。'],
    ['etcd 强一致性', 'etcd 基于 Raft 一致性算法实现强一致性,集群通过 leader 选举 + 日志复制同步状态。任何写操作都需要经过 leader,过半确认后提交。读操作可以走 leader(强一致)或 follower(配合 readindex 保证线性化)。MVCC 通过 key + revision 维护多个版本。'],
    ['MongoDB 复制集', 'MongoDB 复制集通过 oplog 实现主从同步,secondary 通过拉取 oplog 重放操作。Primary 选举基于 Raft,需过半投票。读偏好决定客户端从哪个节点读:primary、primaryPreferred、secondary、secondaryPreferred、nearest。'],
    ['Paxos 算法实现', 'Paxos 算法解决分布式系统一致性问题,有 Basic Paxos 和 Multi-Paxos 两种变体。Basic Paxos 通过 Prepare/Promise/Accept/Learn 四阶段达成共识。Multi-Paxos 复用 Prepare 阶段,通过选出一个 leader 减少消息轮次。ZAB 协议是 Zookeeper 定制版 Paxos。'],
    ['MySQL InnoDB 锁', 'InnoDB 提供多种锁机制:行锁(record lock)、间隙锁(gap lock)、临键锁(next-key lock = record + gap),共同实现 REPEATABLE READ 隔离级别。意向锁是表级锁,表明事务准备在表行上加锁。MVCC 通过 undo log 实现非阻塞读。'],
    ['Nginx 事件模型', 'Nginx 采用 epoll 异步非阻塞事件模型,主进程负责加载配置 + 创建 worker 进程,worker 数通常等于 CPU 核数。worker 通过 epoll_wait 同时处理多个连接的就绪事件。多个 worker 通过共享监听 socket 实现负载均衡,accept 互斥锁避免惊群。'],
    ['分布式追踪', 'OpenTelemetry 提供 W3C Trace Context 标准,trace_id 跨服务传播调用链,span 表示单个操作。采样策略决定是否记录 span(头采样、尾采样、自适应)。后端使用 Jaeger/Tempo 存储 + 查询,通过 service map 展示服务依赖。'],
  ];

  const messages = [];
  for (let i = 0; i < userTopics.length; i++) {
    const [title, body] = userTopics[i];
    messages.push({ role: 'user', content: `请详细说明 ${title},覆盖核心机制。\n\n${body}` });
    messages.push({ role: 'assistant', content: `${title} 的核心要点:\n\n${body.replace(/\.$/, '')} 。\n\n最佳实践:监控、异常路径、测试同步更新。` });
  }
  messages.push({ role: 'user', content: '回顾一下前面讨论的所有 10 个分布式系统主题,简要总结每个主题的核心要点和它们之间的关联。' });

  // Run fetch in CDP page (Runtime.evaluate)
  const fetchResult = await cdpRpc(ws, 'Runtime.evaluate', {
    expression: `
      fetch('${GATEWAY}/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ${CCR_KEY}',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'MiniMax-M3',
          messages: ${JSON.stringify(messages).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')},
          max_tokens: 2000
        })
      })
      .then(async resp => {
        const headers = {};
        for (const [k, v] of resp.headers.entries()) headers[k] = v;
        const body = await resp.json();
        return JSON.stringify({ status: resp.status, headers, body });
      })
      .catch(err => 'ERROR: ' + err.message)
    `,
    awaitPromise: true,
    returnByValue: true
  });

  if (fetchResult.exceptionDetails) {
    console.error('[cdp-helix-verify] CDP exception:', fetchResult.exceptionDetails);
    process.exit(1);
  }

  const parsed = JSON.parse(fetchResult.result.value);
  console.log('[cdp-helix-verify] status:', parsed.status);

  const helixHeaders = {};
  for (const [k, v] of Object.entries(parsed.headers)) {
    if (k.startsWith('x-helix')) helixHeaders[k] = v;
  }
  console.log('[cdp-helix-verify] helix headers:', JSON.stringify(helixHeaders, null, 2));

  const usage = parsed.body?.usage || {};
  const choice = parsed.body?.choices?.[0] || {};
  const content = choice.message?.content || '';

  console.log('[cdp-helix-verify] usage:', JSON.stringify(usage));
  console.log('[cdp-helix-verify] finish_reason:', choice.finish_reason);
  console.log('[cdp-helix-verify] content length:', content.length);
  console.log('[cdp-helix-verify] ---content (first 600)---');
  console.log(content.substring(0, 600));
  console.log('[cdp-helix-verify] ---content (last 400)---');
  console.log(content.substring(content.length - 400));

  // Check if LLM recalled any topic content
  const recallHits = userTopics.filter(([t]) => content.includes(t.split(' ')[0])).map(([t]) => t);
  console.log('[cdp-helix-verify] topic mentions in response:', recallHits.length, '/', userTopics.length);
  recallHits.forEach((t) => console.log('  -', t));

  // Take screenshot
  await cdpRpc(ws, 'Page.navigate', { url: 'http://127.0.0.1:3456/' });
  await new Promise((r) => setTimeout(r, 2000));
  fs.mkdirSync('cdp-shots', { recursive: true });
  const shot = await cdpRpc(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('cdp-shots/cdp-helix-verify.png', Buffer.from(shot.data, 'base64'));
  console.log('[cdp-helix-verify] screenshot saved cdp-shots/cdp-helix-verify.png');

  // Save full result
  const out = {
    timestamp: new Date().toISOString(),
    cdp_endpoint: CDP_HTTP,
    status: parsed.status,
    helix_headers: helixHeaders,
    usage,
    finish_reason: choice.finish_reason,
    content_length: content.length,
    content_preview: content.substring(0, 1000),
    recall_hits_count: recallHits.length,
    recall_hits: recallHits
  };
  fs.writeFileSync('cdp-helix-verify-result.json', JSON.stringify(out, null, 2));
  console.log('[cdp-helix-verify] result saved cdp-helix-verify-result.json');

  ws.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
