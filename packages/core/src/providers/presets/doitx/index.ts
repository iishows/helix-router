import { defaultProviderAccountConfig, type ProviderPreset } from "@ccr/core/providers/presets/types";

export const doitxProviderPreset: ProviderPreset = {
  account: defaultProviderAccountConfig,
  aliases: ["doitx", "doit x", "helix gateway"],
  endpoints: [
    {
      baseUrl: "https://router.doitx.ai",
      protocols: ["anthropic_messages", "openai_chat_completions", "openai_responses"]
    }
  ],
  id: "doitx",
  name: "DoitX",
  websiteUrl: "https://router.doitx.ai/"
};
