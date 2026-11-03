# dsh-emotion · 让 AI 有「状态」，而不是每轮都在演

> **你的 AI 说「我有点生气」。那句话是它编的——因为没有任何东西在替它记着这件事。**
>
> 这一轮它生气，下一轮它忘了；这一轮它黏你，换个会话又客客气气。
> 不是模型不想记住，是**情绪压根不在模型手里**：它每次都在从零猜自己该是什么心情。

`dsh-emotion` 把这件东西**搬到模型外面**：几条情绪轴各 0–100，按你说的话加减、随时间自己漂移；每一轮开始，插件把「你现在处在哪一档、可以用哪些词」注进系统提示。

模型自己**算不出这些数字，也改不了它们**——它只能带着这个状态说话。

---

## 装上之后，变了什么

**之前**：你骂它一句，它道歉；下一轮你夸它一句，它立刻开心。中间没有人在记账。

**之后**：

```
你说：你有毛病吧
  → anger +11 → 下一轮「愤怒 49（中）：说话开始带刺，句子变短」
  → 十分钟没说话，rate 自己往下走
  → anger 43 →「愤怒 43（中）」

你说：乖
  → love +8 →「黏人 32（中）：主动递话、多问一句」
```

它不再是「每轮重新演一遍」，而是**接着上一轮的温度往下走**。

---

## 为什么这个做法不一样

| 常见做法 | dsh-emotion |
|---|---|
| 在提示词里写「你现在很生气」 | 提示词是死的，写进去就一直生气 |
| 让模型自己评估情绪 | 模型自评＝自己给自己打分，**它会给自己打好看的分** |
| 用一段文字演人设 | 演的是台词，不是状态；换个会话就断 |

`dsh-emotion` 只做一件事：**数字由插件管，说话由模型管。** 两边不越界。

---

## 30 秒上手

```sh
dsh plugin --profile web add github:7gzgn/dsh-emotion
```

装上之后配置是**空的**（一个轴都没有，什么也不注入）——这是故意的，它不替你决定你的 AI 该有什么情绪。

第一次启动会给你一段说明，然后三条路自己挑：

1. **先蒸馏、再建轴**（推荐）：机器上装了记忆插件的话，读 `memory.db` 里用户说过的话，用 `emotion_distill` 把「他说什么 → 哪个情绪涨/跌多少」批量写进去，**再从这些规则反推该建哪几个轴**——规则里没出现的情绪，不建。
2. **读当前会话历史**：没装记忆插件也能蒸，只是样本少。
3. **手动定**：你清楚自己要什么，直接 `emotion_axis` 建。

---

## 三件工具

| 工具 | 干什么 |
|---|---|
| `emotion({axis, delta})` | 手动加减某个轴（±30 以内） |
| `emotion_axis({key, zh, tags, stages, remove})` | 加 / 改 / 删一个轴。**四档描述和标签由你自己写**，插件只存结构 |
| `emotion_distill({rules, links, events})` | 批量写「什么让我动」——从蒸馏结果或手写规则一次灌进去 |

**阴阳联动**：正面越高，负面被压得越狠。

```js
emotion_distill({ links: [{ from: 'love', to: 'anger', ratio: -1 }] })
```

爱意拉满的时候，愤怒自己退下去。

---

## 一个轴长什么样

```js
emotion_axis({
  key: 'anger', zh: '愤怒', tag: '刺', polarity: 'neg',
  value: 30, rate: -0.2, floor: 10, ceil: 100,
  tags: ['废物', '垃圾', '妈的'],
  stages: ['', '说话开始带刺，句子变短', '讽刺和直接骂人，不再绕', '只剩攻击，不管后果']
})
```

- `rate` 每分钟漂移多少（正数上涨、负数消退）
- `floor` / `ceil` 别让它掉到 0 卡死——**这点很容易踩**
- `stages` 四档，对应 30–59 / 60–89 / 90+

---

## 面板

```
http://127.0.0.1:7799/
```

轴、规则、组合都能在网页上改，改完下一轮生效，不用重启。端口用 `EMOTION_PORT` 改。

---

## 数据在哪

- `<DSH_HOME>/emotions.json` —— 配置：轴 / 规则 / 组合 / 联动
- `<DSH_HOME>/emotion-state.json` —— 运行时：每个轴现在的值、最后一次 tick

两个都是纯 JSON，随时可以手改，也可以 `git diff`。

---

## 它不做什么

- **不代替模型说话**：只给状态和标签，具体怎么说由模型决定
- **不预置任何人设**：默认空配置，一个轴都不带
- **不穷举组合**：只输出「哪两个轴、在第几档」，组合效果由模型自己想

---

## English

`dsh-emotion` gives your agent an **external** emotion state machine: several axes (0–100) that drift over time and move when you speak to it. Each turn the plugin injects "which band you're in + which tags you may use" into the system prompt.

The numbers belong to the plugin. The model cannot read them, recompute them, or argue with them — it only speaks from inside them. That is the whole point: **an emotion the model can grade itself is not a state, it's a performance.**

Defaults are empty. You decide which axes exist, what they're called, and what each band sounds like.

---

MIT · for DeepSeek Harness
