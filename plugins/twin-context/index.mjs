import fs from "node:fs";
import path from "node:path";

export const name = "diandian-twin-context";
export const inject = ["systemPrompt"];

function readFileSafe(filePath, maxChars = 6000) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return "";
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n...(已截断)` : raw;
  } catch {
    return "";
  }
}

function buildTwinPromptBlock() {
  const twinDir = (process.env.DIANDIAN_TWIN_DIR || "").trim();
  if (!twinDir) return "";

  const profileMd = readFileSafe(path.join(twinDir, "PROFILE.md"), 4500);
  const styleMd = readFileSafe(path.join(twinDir, "STYLE.md"), 4500);
  if (!profileMd && !styleMd) return "";

  const sections = [
    "以下是用户长期沉淀的个人阅读画像（PROFILE.md）与表达风格规则（STYLE.md）。在讨论书籍、提炼观点、撰写书评/读后感或卡片文案时，必须自然对齐用户的视角与口吻，严禁违背其中的去 AI 味禁忌：",
  ];
  if (profileMd) {
    sections.push("<user_reading_profile>", profileMd, "</user_reading_profile>");
  }
  if (styleMd) {
    sections.push("<user_writing_style>", styleMd, "</user_writing_style>");
  }
  return sections.join("\n");
}

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: "diandian:twin-profile",
    order: 500,
    interpolate: false,
    text: () => buildTwinPromptBlock(),
  });
}
