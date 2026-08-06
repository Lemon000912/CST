/** 空会话封面主标题（随机），风格接近 ChatGPT 欢迎语 */
export const WELCOME_HEADLINES = [
  "今天我能帮你什么？",
  "有什么可以帮你的吗？",
  "你好，需要我做什么？",
  "我在这儿，随时开始。",
  "今天想查什么主题？",
  "从一句话或一份文件开始都可以。",
  "准备好帮你做联网搜索了。",
  "说说你想了解的问题吧。",
  "我该如何协助你？",
  "有什么想查清楚的？",
  "开始你的下一次提问。",
];

/** 副行：简短、不罗列功能按钮 */
export const WELCOME_SUBLINES = [
  "在下方输入或上传文件即可。",
  "用自然语言描述即可，我会理解你的意图。",
  "网页渠道可全网搜索；数据库渠道可查论文与专利。",
  "随便聊聊你的课题也行。",
  "中英文都可以。",
  "需要时可在侧栏配置大模型。",
];

export function pickWelcomeCopy(): { headline: string; subline: string } {
  const hi = WELCOME_HEADLINES[Math.floor(Math.random() * WELCOME_HEADLINES.length)] ?? WELCOME_HEADLINES[0];
  const si = WELCOME_SUBLINES[Math.floor(Math.random() * WELCOME_SUBLINES.length)] ?? WELCOME_SUBLINES[0];
  return { headline: hi, subline: si };
}
