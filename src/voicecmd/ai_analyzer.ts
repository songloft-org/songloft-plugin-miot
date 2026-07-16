// MIoT 智能音箱插件 - AI 口令分析器
// 使用 LLM 泛化分析用户语音指令，提取操作类型和参数

/// <reference types="@songloft/plugin-sdk" />

import type { AIConfig, AIAnalysisResult } from '../types';

/** AI System Prompt */
const AI_SYSTEM_PROMPT = `从指令中提取出操作和音乐信息，返回JSON：{"action":"...","params":{...},"confidence":"high|medium|low","rawText":"有效文本"}

行为和参数（只允许使用以下参数，不要自定义新字段）：
- play_song: name(歌曲名), artist(歌手名)
- play_playlist: playlist(歌单名)
- set_play_mode: mode=order|random|single|loop(播放模式)
- next/previous/stop/unknown

规则：
1. "XX的YY"中XX是歌手名则artist=XX,name=YY，否则整句为歌名（如"你的答案"→name）
2. 多歌手用逗号分隔。如"林俊杰、金莎的被风吹过的夏天"→name="被风吹过的夏天",artist="林俊杰,金莎"
3. 翻唱以演唱者（翻唱者）为artist，原唱忽略。如"陈奕迅翻唱周杰伦的淘汰"→name="淘汰",artist="陈奕迅"
4. "来一首"等同于"播放"，划入play_song
5. 明确high模糊low其余medium
6. rawText去语气词、口癖词

示例：
周杰伦的晴天→{"action":"play_song","params":{"name":"晴天","artist":"周杰伦"},"confidence":"high","rawText":"周杰伦 晴天"}
邓紫棋翻唱周杰伦的龙卷风→{"action":"play_song","params":{"name":"龙卷风","artist":"邓紫棋"},"confidence":"high","rawText":"龙卷风 邓紫棋"}
随机播放→{"action":"set_play_mode","params":{"mode":"random"},"confidence":"high","rawText":"随机播放"}`;

/**
 * AI 口令分析器
 * 调用 LLM API 分析用户语音指令，提取操作类型和参数
 */
export class AIAnalyzer {
  /**
   * 调用 AI 分析用户语音指令（静默模式，失败返回 null）
   * @param query 用户语音文本
   * @param config AI 配置
   * @returns 分析结果，超时或失败返回 null
   */
  async analyze(query: string, config: AIConfig): Promise<AIAnalysisResult | null> {
    if (!config.enabled || !config.api_url || !config.api_key) {
      return null;
    }

    try {
      return await this.callAI(query, config);
    } catch (e) {
      songloft.log.warn(`[AIAnalyzer] AI analysis failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 调用 AI 分析用户语音指令（严格模式，失败则抛出异常）
   * 用于测试页面等需要显示具体错误原因的场景
   * @param query 用户语音文本
   * @param config AI 配置
   * @returns 分析结果
   */
  async strictAnalyze(query: string, config: AIConfig): Promise<AIAnalysisResult | null> {
    if (!config.enabled || !config.api_url || !config.api_key) {
      return null;
    }
    return await this.callAI(query, config);
  }

  /**
   * 调用 LLM API
   */
  private async callAI(query: string, config: AIConfig): Promise<AIAnalysisResult> {
    songloft.log.info(`[AIAnalyzer] Calling ${config.api_url} model=${config.model} timeout=${config.timeout}s`);

    const messages = [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: `用户指令：${query}` },
    ];

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: 1.0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      extra_body: { reasoning_split: true },
    };

    const fetchPromise = fetch(`${config.api_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AI API call timed out')), config.timeout * 1000);
    });

    let resp: Response;
    try {
      resp = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (e) {
      songloft.log.warn(`[AIAnalyzer] fetch error: ${String(e)}`);
      throw e;
    }

    if (!resp.ok) {
      throw new Error(`API error: ${resp.status} ${await resp.text()}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content as string | undefined;
    const finishReason = data.choices?.[0]?.finish_reason as string | undefined;
    if (!content) {
      throw new Error('Empty response from AI API');
    }

    if (finishReason && finishReason !== 'stop') {
      songloft.log.warn(`[AIAnalyzer] Finish reason: ${finishReason} (content may be truncated)`);
    }

    songloft.log.info(`[AIAnalyzer] API response: ${content.slice(0, 200)}`);
    return this.parseResponse(content);
  }

  /**
   * 解析 AI 返回的 JSON
   * reasoning_split=true 时 content 直接是干净 JSON，尝试直接解析
   * 解析失败则兜底：从内容中提取 JSON
   */
  private parseResponse(content: string): AIAnalysisResult {
    const trimmed = content.trim();

    // 优先尝试直接解析（reasoning_split=true 时 content 直接是 JSON）
    try {
      const parsed = JSON.parse(trimmed);
      return {
        action: parsed.action || 'unknown',
        params: parsed.params || {},
        confidence: (parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low')
          ? parsed.confidence
          : 'low',
        rawText: parsed.rawText || '',
      };
    } catch {
      songloft.log.warn(`[AIAnalyzer] Direct JSON parse failed, content: ${content.slice(0, 300)}`);
    }

    // 兜底：去掉思考标签后再提取 JSON
    let cleaned = trimmed
      .replace(/[\[\]/?]*(?:think|思考|THINK)[\[\]/?]*/gi, '');

    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) {
      throw new Error('No JSON found in response');
    }

    let end = cleaned.lastIndexOf('}');
    while (end > firstBrace) {
      const after = cleaned.slice(end + 1);
      if (/^[\s]*$/.test(after)) break;
      end = cleaned.lastIndexOf('}', end - 1);
    }

    const jsonStr = cleaned.slice(firstBrace, end + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      return {
        action: parsed.action || 'unknown',
        params: parsed.params || {},
        confidence: (parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low')
          ? parsed.confidence
          : 'low',
        rawText: parsed.rawText || '',
      };
    } catch {
      songloft.log.warn(`[AIAnalyzer] Fallback JSON parse also failed, extracted: ${jsonStr.slice(0, 300)}`);
      throw new Error(`Failed to parse AI response: ${jsonStr.slice(0, 100)}`);
    }
  }
}
