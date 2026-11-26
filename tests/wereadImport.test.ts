import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ZlibCliService } from "../electron/router/zlibCliService";

const runCli = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => {
  const child = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...child, execFile: Object.assign(vi.fn(), { [promisify.custom]: runCli }) };
});

let temp: string;
let root: string;
let book: string;
let service: ZlibCliService;
const fromLibrary = { fromLibrary: true };
const receipt = (existing = false) => ({ stdout: JSON.stringify({ book_id: "CB-test", already_existed: existing }), stderr: "" });

beforeEach(async () => {
  vi.stubEnv("DIANDIAN_ZLIB_BIN", process.execPath);
  runCli.mockReset();
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "diandian-weread-import-"));
  root = path.join(temp, "downloads");
  book = path.join(root, "已经下载的书.EPUB");
  await fs.mkdir(root);
  await fs.writeFile(book, "book");
  service = new ZlibCliService(root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(temp, { recursive: true, force: true });
});

it("shares in-flight imports of the same file across entry points and reports an existing remote copy", async () => {
  runCli.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(receipt()), 80)));
  const results = await Promise.all([service.importToWeRead(book, fromLibrary), service.importToWeRead(book)]);
  expect(results.map(result => result.alreadyExisted)).toEqual([false, false]);
  expect(runCli).toHaveBeenCalledTimes(1);
  expect(runCli.mock.calls[0]?.[1]).toEqual(["weread", "import", await fs.realpath(book), "--json"]);
  runCli.mockResolvedValueOnce(receipt(true));
  expect((await service.importToWeRead(book, fromLibrary)).alreadyExisted).toBe(true);
});

it("restricts library transfers to supported books inside the library while keeping manual picks available", async () => {
  const outside = path.join(temp, "外部文件.txt");
  const unsupported = path.join(root, "文档.docx");
  await fs.writeFile(outside, "text");
  await fs.writeFile(unsupported, "docx");
  await expect(service.importToWeRead(outside, fromLibrary)).rejects.toThrow("下载目录");
  await expect(service.importToWeRead(unsupported, fromLibrary)).rejects.toThrow("微信读书支持导入");
  await fs.unlink(book);
  await expect(service.importToWeRead(book, fromLibrary)).rejects.toThrow("已移动");
  expect(runCli).not.toHaveBeenCalled();
  runCli.mockResolvedValueOnce(receipt());
  await expect(service.importToWeRead(outside)).resolves.toMatchObject({ alreadyExisted: false });
});

it("distinguishes authentication, network errors and unconfirmed outcomes, allowing later retry", async () => {
  for (const [stderr, expected] of [
    ["Error: not logged in to WeRead", "连接与偏好"],
    ["WeRead session expired or was revoked", "连接与偏好"],
    ["WeRead is unreachable", "检查网络"],
    ["WeRead did not confirm the import; check the shelf before retrying", "尚未确认"],
  ]) {
    runCli.mockRejectedValueOnce({ stderr });
    await expect(service.importToWeRead(book, fromLibrary)).rejects.toThrow(expected);
  }
  for (const stdout of ["", "{}", "uploading…", '{"already_existed":false}']) {
    runCli.mockResolvedValueOnce({ stdout, stderr: "" });
    await expect(service.importToWeRead(book, fromLibrary)).rejects.toThrow("尚未确认");
  }
  runCli.mockResolvedValueOnce(receipt());
  await expect(service.importToWeRead(book, fromLibrary)).resolves.toMatchObject({ alreadyExisted: false });
});
