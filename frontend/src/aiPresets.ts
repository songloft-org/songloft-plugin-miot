export interface AIPresetProvider {
  id: string;
  name: string;
  baseUrl: string; // 已含正确版本段（无尾斜杠）
  defaultModel: string;
  supportsJsonMode: boolean; // 硬约束提示：AIAnalyzer 强制 json_object
  isSiliconFlow?: boolean; // 决定是否附加 reasoning_split 扩展
  category: 'cn_cloud';
  websiteUrl: string;
}

export const AI_PRESET_PROVIDERS: AIPresetProvider[] = [
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen3-32B',
    supportsJsonMode: true,
    isSiliconFlow: true,
    category: 'cn_cloud',
    websiteUrl: 'https://siliconflow.cn',
  },
  {
    id: 'zhipu',
    name: '智谱 BigModel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    supportsJsonMode: true,
    category: 'cn_cloud',
    websiteUrl: 'https://open.bigmodel.cn',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-flash',
    supportsJsonMode: true,
    category: 'cn_cloud',
    websiteUrl: 'https://dashscope.aliyuncs.com',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    supportsJsonMode: true,
    category: 'cn_cloud',
    websiteUrl: 'https://platform.deepseek.com',
  },
  {
    id: 'volcengine',
    name: '火山方舟 Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-1-6',
    supportsJsonMode: true,
    category: 'cn_cloud',
    websiteUrl: 'https://www.volcengine.com',
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    supportsJsonMode: true,
    category: 'cn_cloud',
    websiteUrl: 'https://platform.moonshot.cn',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'abab6.5s-chat',
    supportsJsonMode: true,
    category: 'cn_cloud',
    websiteUrl: 'https://www.minimax.chat',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultModel: 'hunyuan-turbo',
    supportsJsonMode: true,
    category: 'cn_cloud',
    websiteUrl: 'https://cloud.tencent.com',
  },
];
