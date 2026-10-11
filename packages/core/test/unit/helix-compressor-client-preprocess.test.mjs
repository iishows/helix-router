/**
 * Helix Compressor 客户端 preprocess + skills reminder 压缩测试
 *
 * 覆盖 PR-1 (clientPreprocess) + PR-2 (clientCompactSkills)
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  clientPreprocess,
  clientCompactSkills
} from "@ccr/core/plugins/built-ins/helix-compressor.ts";

// ============= PR-1: clientPreprocess 测试 =============

test("clientPreprocess: 过滤空字符串 user 消息", () => {
  const input = [
    { role: "user", content: "" },
    { role: "user", content: "actual question" },
    { role: "assistant", content: "answer" }
  ];
  const out = clientPreprocess(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].content, "actual question");
  assert.equal(out[1].content, "answer");
});

test("clientPreprocess: 过滤 content 是 [{text:''}] 形态的 assistant 空消息", () => {
  const input = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "" }] },  // 数组非空但内容全空
    { role: "assistant", content: [{ type: "text", text: "real answer" }] }
  ];
  const out = clientPreprocess(input);
  assert.equal(out.length, 2);
  assert.equal(out[1].content, "real answer");
});

test("clientPreprocess: 过滤 content 是空数组 [] 的消息", () => {
  const input = [
    { role: "user", content: [] },
    { role: "user", content: "real" }
  ];
  const out = clientPreprocess(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "real");
});

test("clientPreprocess: 删除 7 条 task-notification 死信(成功状态)", () => {
  const input = [
    { role: "user", content: "real question" },
    { role: "user", content: "<task-notification>\n<task-id>x</task-id>\n<retrieval_status>success</retrieval_status>\n</task-notification>" },
    { role: "user", content: "<task-notification>\n<task-id>y</task-id>\n<retrieval_status>success</retrieval_status>\n</task-notification>" },
    { role: "assistant", content: "answer" }
  ];
  const out = clientPreprocess(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].content, "real question");
  assert.equal(out[1].content, "answer");
});

test("clientPreprocess: 保留 file_modified 类 <system-reminder>", () => {
  const reminder = "<system-reminder>Note: D:\\one-hub\\model\\pricing.go was modified, either by the user or by a linter. This change is intentional. Make sure to take it into account as you proceed (ie. don't revert it unless asked).</system-reminder>";
  const input = [
    { role: "user", content: "Q1" },
    { role: "user", content: reminder },
    { role: "user", content: "Q2" }
  ];
  const out = clientPreprocess(input);
  assert.equal(out.length, 3, "file_modified 不应被删");
  assert.ok(out[1].content.includes("was modified"));
});

test("clientPreprocess: 保留 cache_control 字段(Anthropic prompt caching)", () => {
  const input = [
    {
      role: "user",
      content: [{ type: "text", text: "important message" }, { type: "text", text: "", cache_control: { type: "ephemeral" } }]
    }
  ];
  const out = clientPreprocess(input);
  // 注意:此消息 text 不是全空(content[0] 有真实文字),应保留
  assert.equal(out.length, 1);
  assert.equal(out[0].content[1].cache_control.type, "ephemeral");
});

test("clientPreprocess: 保留 task-notification 但 retrieval_status=pending", () => {
  const input = [
    { role: "user", content: "<task-notification>\n<retrieval_status>pending</retrieval_status>\n</task-notification>" }
  ];
  const out = clientPreprocess(input);
  assert.equal(out.length, 1, "pending 状态的 task-notif 不应被删");
});

// ============= PR-2: clientCompactSkills 测试 =============

test("clientCompactSkills: 无 Skill 调用时替换 27 KB skills reminder 为压缩索引", () => {
  const skillsReminder = "<system-reminder>The following skills are available for use with the Skill tool:\n\n- skill1: description1...\n- skill2: description2...\n...(重复)" + "x".repeat(25000) + "</system-reminder>";
  const input = [
    { role: "user", content: "regular question" },
    { role: "user", content: skillsReminder }
  ];
  const out = clientCompactSkills(input);
  assert.equal(out.length, 2);
  assert.ok(!out[1].content.includes("重复"), "原文 27 KB 不应保留");
  assert.ok(out[1].content.includes("分类索引"), "应替换为索引");
});

test("clientCompactSkills: 本会话调用过 Skill tool 时不替换", () => {
  const skillsReminder = "<system-reminder>The following skills are available for use with the Skill tool: ...</system-reminder>";
  const input = [
    { role: "user", content: skillsReminder },
    {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Skill", input: { name: "ads-audit" } }
      ]
    }
  ];
  const out = clientCompactSkills(input);
  // Skill 调用存在 → 不应替换
  assert.equal(out[1].content, skillsReminder, "有 Skill 调用时保留原文");
});

test("clientCompactSkills: 处理 content 是 array 形态的 skills reminder", () => {
  const skillsText = "The following skills are available for use with the Skill tool: ...";
  const input = [
    {
      role: "user",
      content: [
        { type: "text", text: "intro" },
        { type: "text", text: skillsText + "y".repeat(25000) }
      ]
    }
  ];
  const out = clientCompactSkills(input);
  assert.equal(out[0].content[0].text, "intro", "其他文本块不变");
  assert.ok(out[0].content[1].text.includes("分类索引"), "skills 块被压缩");
});

test("clientCompactSkills: 幂等(重复调用结果相同)", () => {
  const skillsReminder = "<system-reminder>The following skills are available for use with the Skill tool: original</system-reminder>";
  const input = [{ role: "user", content: skillsReminder }];
  const out1 = clientCompactSkills(input);
  const out2 = clientCompactSkills(out1);
  // 第二次调用应不再触发(压缩索引不含触发词)
  assert.equal(out2.length, 1);
  assert.equal(out2[0].content, out1[0].content, "第二次调用应不改变");
});

test("clientCompactSkills: 没有 skills reminder 时不动作", () => {
  const input = [{ role: "user", content: "regular" }];
  const out = clientCompactSkills(input);
  assert.deepEqual(out, input, "无 skills reminder 时不修改");
});

// ============= 综合测试: 实测样本结构 =============

test("综合: 处理实测样本结构(124 user 空 + 98 assistant 空 + 7 task-notif + 1 skills reminder)", () => {
  // 构造一个反映样本统计特征的输入
  const messages = [];
  // 124 条 user 空消息
  for (let i = 0; i < 124; i++) messages.push({ role: "user", content: "" });
  // 98 条 assistant 空消息(content 是 [{text:''}])
  for (let i = 0; i < 98; i++) messages.push({ role: "assistant", content: [{ type: "text", text: "" }] });
  // 1 条真实问题
  messages.push({ role: "user", content: "real question" });
  // 7 条 task-notif 死信
  for (let i = 0; i < 7; i++) messages.push({
    role: "user",
    content: `<task-notification>\n<task-id>${i}</task-id>\n<retrieval_status>success</retrieval_status>\n</task-notification>`
  });
  // 1 条真实回答
  messages.push({ role: "assistant", content: "real answer" });
  // 1 条 skills reminder
  messages.push({
    role: "user",
    content: "<system-reminder>The following skills are available for use with the Skill tool: " + "x".repeat(25000) + "</system-reminder>"
  });

  // PR-1
  const afterPreprocess = clientPreprocess(messages);
  // 124 user 空 + 98 assistant 空 + 7 task-notif 应全部消失
  assert.equal(afterPreprocess.length, 3, `应为 3 条(1 问题 + 1 回答 + 1 skills),实际 ${afterPreprocess.length}`);
  assert.equal(afterPreprocess[0].content, "real question");
  assert.equal(afterPreprocess[1].content, "real answer");

  // PR-2
  const afterCompact = clientCompactSkills(afterPreprocess);
  // skills reminder 应被压缩,但长度可能因替换而变化
  assert.equal(afterCompact.length, 3);
  assert.ok(afterCompact[2].content.includes("分类索引"), "skills reminder 应被压缩");
  assert.ok(!afterCompact[2].content.includes("x".repeat(1000)), "原 27 KB 文本应消失");
});