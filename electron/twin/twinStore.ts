import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface TwinProfileState {
  profileMd: string;
  styleMd: string;
  sha256: string;
  twinDir: string;
  updatedAt: string;
}

export const DEFAULT_PROFILE_MD = `# 我的阅读画像（PROFILE）

- **关注领域**：产品思考、技术演进、认知心理、商业史与深度非虚构
- **阅读目标**：不追求速读数量，重视把书中的结构性洞见与自己的工作/生活经验建立连接
- **当前角色**：独立创作者 / 长期思考者（可随时在这里替换为你自己的真实背景）
`;

export const DEFAULT_STYLE_MD = `# 我的写作与表达风格（STYLE）

- **去 AI 味硬规矩**：
  - 禁用「总而言之」「值得注意的是」「这是一本发人深省的书」「在当今快节奏的社会」等空洞套话
  - 少用排比句和机械的「第一/第二/第三」总分总模板
- **表达质感**：
  - 第一人称克制叙述，像和聪明朋友喝咖啡聊天，直接给判断，再用原书细节或个人经历撑住观点
  - 优先保留原书里锋利的原话、反常识案例或具体数字
  - 段落短小透气，适合在小红书图文、公众号随笔或个人双链笔记中直接复用
`;

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function computeTwinDigest(profileMd: string, styleMd: string): string {
  return crypto.createHash("sha256").update(profileMd, "utf8").update("\0").update(styleMd, "utf8").digest("hex");
}

export class TwinStore {
  readonly twinDir: string;
  private readonly profilePath: string;
  private readonly stylePath: string;

  constructor(userDataDir: string) {
    this.twinDir = path.join(userDataDir, "twin");
    this.profilePath = path.join(this.twinDir, "PROFILE.md");
    this.stylePath = path.join(this.twinDir, "STYLE.md");
    this.ensureSeedFiles();
  }

  private ensureSeedFiles(): void {
    fs.mkdirSync(this.twinDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.profilePath)) {
      atomicWrite(this.profilePath, DEFAULT_PROFILE_MD);
    }
    if (!fs.existsSync(this.stylePath)) {
      atomicWrite(this.stylePath, DEFAULT_STYLE_MD);
    }
  }

  read(): TwinProfileState {
    this.ensureSeedFiles();
    const profileMd = fs.readFileSync(this.profilePath, "utf8");
    const styleMd = fs.readFileSync(this.stylePath, "utf8");
    const pStat = fs.statSync(this.profilePath);
    const sStat = fs.statSync(this.stylePath);
    const latestMs = Math.max(pStat.mtimeMs, sStat.mtimeMs);
    return {
      profileMd,
      styleMd,
      sha256: computeTwinDigest(profileMd, styleMd),
      twinDir: this.twinDir,
      updatedAt: new Date(latestMs).toISOString(),
    };
  }

  save(input: { profileMd?: string; styleMd?: string }): TwinProfileState {
    this.ensureSeedFiles();
    if (typeof input.profileMd === "string") {
      atomicWrite(this.profilePath, input.profileMd);
    }
    if (typeof input.styleMd === "string") {
      atomicWrite(this.stylePath, input.styleMd);
    }
    return this.read();
  }

  /**
   * Non-destructive mergeDistillWrite: appends user-approved learned rules under
   * a dedicated section without touching or overwriting any manual rules above.
   */
  appendLearnedStyleRules(rules: string[]): { state: TwinProfileState; addedCount: number } {
    this.ensureSeedFiles();
    const current = fs.readFileSync(this.stylePath, "utf8");
    const norm = (s: string) => s.replace(/^[-*•\s]+/, "").replace(/\s+/g, "").toLowerCase();
    const existingLines = new Set(
      current
        .split("\n")
        .map((l) => norm(l))
        .filter((l) => l.length > 0),
    );

    const toAdd: string[] = [];
    for (const raw of rules) {
      const clean = raw.trim().replace(/^[-*•\s]+/, "");
      if (!clean) continue;
      const key = norm(clean);
      if (existingLines.has(key)) continue;
      existingLines.add(key);
      toAdd.push(`- ${clean}`);
    }
    if (toAdd.length === 0) {
      return { state: this.read(), addedCount: 0 };
    }

    const sectionHeader = "## 从人工改稿自动沉淀的习惯";
    let nextStyle: string;
    if (current.includes(sectionHeader)) {
      nextStyle = `${current.trimEnd()}\n${toAdd.join("\n")}\n`;
    } else {
      nextStyle = `${current.trimEnd()}\n\n${sectionHeader}\n\n${toAdd.join("\n")}\n`;
    }
    atomicWrite(this.stylePath, nextStyle);
    return { state: this.read(), addedCount: toAdd.length };
  }
}
