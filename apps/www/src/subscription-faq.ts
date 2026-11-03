/** English subscription answer shared by the homepage and the Grok Bot page. */
export const CLAUDE_CHATGPT_SUBSCRIPTION_FAQ = {
  question: "Can I use my Claude Pro/Max or ChatGPT Plus/Pro subscription?",
  answer:
    "No. A deployment offers two model providers: the Doitx router at router.doitx.ai, and a local OpenAI-compatible server the operator runs. Each person connects their own key for either one. Doitx does not pay the model bill.",
} as const;
