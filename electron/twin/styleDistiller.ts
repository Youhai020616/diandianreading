import crypto from "node:crypto";
import type { ModelSettings } from "../security/secretStore";

export interface StyleDistillSuggestion {
  id: string;
  rule: string;
  reason: string;
  source: "llm" | "heuristic";
}

const AI_CLICHES = [
  "总而言之",
  "综上所述",
  "值得注意的是",
  "不仅如此",
  "毋庸置疑",
  "显而易见",
  "归根结底",
  "发人深省",
  "在当今快节奏",
  "正如作者所说",
  "总的来说",
  "由此可见",
  "简而言之",
];

function avgSentenceLen(text: string): number {
  const parts = text
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  if (parts.length === 0) return 0;
  return parts.reduce((acc, s) => acc + s.length, 0) / parts.length;
}

/**
 * Fast, deterministic diff heuristics comparing AI v1 vs. Human revision.
 * Works offline and serves as immediate fallback when LLM distillation is skipped/unavailable.
 */
export function buildHeuristicStyleSuggestions(
  aiOriginal: string,
  humanRevision: string,
  currentStyleMd: string,
): StyleDistillSuggestion[] {
  const ai = aiOriginal.trim();
  const human = humanRevision.trim();
  if (!ai || !human || ai === human) return [];

  const out: StyleDistillSuggestion[] = [];
  const existingNorm = currentStyleMd.toLowerCase();

  // 1. Detect deleted AI cliché phrases
  const removedCliches = AI_CLICHES.filter((c) => ai.includes(c) && !human.includes(c));
  if (removedCliches.length > 0) {
    const listed = removedCliches.slice(0, 4).map((c) => `「${c}」`).join("、");
    const rule = `避免使用 ${listed} 等过渡套话，直接切入真实判断`;
    if (!existingNorm.includes(removedCliches[0]!.toLowerCase())) {
      out.push({
        id: `heu_${crypto.randomBytes(4).toString("hex")}`,
        rule,
        reason: `你在改稿时主动删掉了 AI 原稿里的 ${listed}`,
        source: "heuristic",
      });
    }
  }

  // 2. Detect significantly tighter / shorter sentence rhythm
  const aiAvg = avgSentenceLen(ai);
  const huAvg = avgSentenceLen(human);
  if (aiAvg >= 26 && huAvg > 0 && huAvg <= aiAvg * 0.78) {
    const rule = "多用短句与清晰断行，单句尽量简洁克制，避免冗长从句堆叠";
    if (!existingNorm.includes("短句")) {
      out.push({
        id: `heu_${crypto.randomBytes(4).toString("hex")}`,
        rule,
        reason: `你的改稿平均句长从 ${Math.round(aiAvg)} 字压缩到了 ${Math.round(huAvg)} 字，节奏更利落`,
        source: "heuristic",
      });
    }
  }

  // 3. Detect stripping numbered list boilerplate ("第一/第二/第三" or excessive emoji)
  const aiNumHeadings = (ai.match(/(?:第一|第二|第三|首先|其次|最后)/g) ?? []).length;
  const huNumHeadings = (human.match(/(?:第一|第二|第三|首先|其次|最后)/g) ?? []).length;
  if (aiNumHeadings >= 2 && huNumHeadings === 0) {
    const rule = "用自然推进的叙述替代「首先/其次/最后」或「第一/第二/第三」八股结构";
    if (!existingNorm.includes("首先/其次")) {
      out.push({
        id: `heu_${crypto.randomBytes(4).toString("hex")}`,
        rule,
        reason: "你移除了 AI 原稿中的机械序号过渡词",
        source: "heuristic",
      });
    }
  }

  // 4. Detect stronger first-person concrete voice
  const aiFirstPerson = (ai.match(/我/g) ?? []).length;
  const huFirstPerson = (human.match(/我/g) ?? []).length;
  if (huFirstPerson >= aiFirstPerson + 3 && !existingNorm.includes("真实经历")) {
    out.push({
      id: `heu_${crypto.randomBytes(4).toString("hex")}`,
      rule: "优先用第一人称真实经历和具体细节切入观点，少做上帝视角泛泛总结",
      reason: "你在改稿中显著增加了第一人称「我」的个人视角表达",
      source: "heuristic",
    });
  }

  return out.slice(0, 3);
}

/**
 * Distill 1–3 concise, actionable STYLE.md rules from the diff between an AI draft
 * and the user's manual revision (zero-tool LLM pass with safe deterministic fallback).
 */
export async function distillStyleFromRevisionDiff(input: {
  aiOriginal: string;
  humanRevision: string;
  currentStyleMd: string;
  modelSettings?: ModelSettings | null;
}): Promise<StyleDistillSuggestion[]> {
  const ai = input.aiOriginal.trim();
  const human = input.humanRevision.trim();
  if (!ai || !human || ai === human) return [];

  // Require meaningful edit delta (at least 10 chars difference)
  if (Math.abs(ai.length - human.length) < 6 && ai.slice(0, 80) === human.slice(0, 80)) {
    return buildHeuristicStyleSuggestions(ai, human, input.currentStyleMd);
  }

  const heur = buildHeuristicStyleSuggestions(ai, human, input.currentStyleMd);
  const ms = input.modelSettings;
  if (!ms?.apiKey || !ms.baseUrl || !ms.model) {
    return heur;
  }

  try {
    const cleanBase = ms.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${cleanBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ms.apiKey}`,
      },
      body: JSON.stringify({
        model: ms.model,
        temperature: 0.2,
        max_tokens: 360,
        messages: [
          {
            role: "system",
            content:
              "你是写作风格分析助手。对比「AI 初稿」和「用户人工改稿」，提炼 1-3 条极简、具体、可直接写入 STYLE.md 的个人写作偏好规则（每条 rule <= 38 字，reason <= 32 字）。禁止重复已有 STYLE.md 的规则。严格只输出 JSON 数组：[{\"rule\":\"...\",\"reason\":\"...\"}]，不要输出 Markdown 代码块或任何多余解释。",
          },
          {
            role: "user",
            content: `【已有 STYLE.md】\n${input.currentStyleMd.slice(0, 1200)}\n\n【AI 初稿】\n${ai.slice(0, 1800)}\n\n【用户人工改稿】\n${human.slice(0, 1800)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) return heur;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = (data.choices?.[0]?.message?.content ?? "").trim();
    const jsonMatch = /\[[\s\S]*\]/.exec(raw);
    if (!jsonMatch) return heur;

    const parsed = JSON.parse(jsonMatch[0]) as Array<{ rule?: string; reason?: string }>;
    if (!Array.isArray(parsed)) return heur;

    const llmSuggestions: StyleDistillSuggestion[] = parsed
      .map((item) => ({
        id: `llm_${crypto.randomBytes(4).toString("hex")}`,
        rule: String(item?.rule ?? "").trim(),
        reason: String(item?.reason ?? "").trim() || "从本次人工修订对比提炼",
        source: "llm" as const,
      }))
      .filter((s) => s.rule.length >= 6 && s.rule.length <= 80)
      .slice(0, 3);

    return llmSuggestions.length > 0 ? llmSuggestions : heur;
  } catch {
    return heur;
  }
}
