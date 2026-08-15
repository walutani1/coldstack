import "server-only";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_TIMEOUT_MS = 120_000;

export type CliRunResult = { command: string; stdout: string; stderr: string };

/* Where `codex exec --output-last-message` should drop the final assistant
   message. Codex prints a whole transcript to stdout (banner, session id, the
   echoed prompt, token counts), so stdout is unusable as a cell value; this file
   holds the answer and nothing else. Fresh name per attempt so a retry can never
   read the previous attempt's leftover message. */
export function codexLastMessagePath(): string {
  return join(tmpdir(), `codex-last-${randomUUID()}.txt`);
}

export function withModelFlag(command: string, flag: string, model: string): string {
  const clean = model.trim();
  if (!clean || command.includes("--model") || / -m /.test(command)) return command;
  // Single-quote the value: the CLIs accept bracketed ids like "opus[1m]", and
  // the command runs through a shell, where an unquoted bracket is a glob.
  // The caller restricts the character set, so there is no quote to escape.
  const suffix = `${flag} '${clean}'`;
  return command.endsWith(" -") ? `${command.slice(0, -2)} ${suffix} -` : `${command} ${suffix}`;
}

export function runCliPrompt(
  command: string,
  prompt: string,
  options: { outputFile?: string } = {},
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    // Run the CLI on the local SUBSCRIPTION only. The app's environment carries an
    // Anthropic API key (used by the anthropic-api provider), which the Claude CLI
    // would otherwise fall back to when the subscription is throttled/at its limit -
    // silently billing that key and, if it is out of credit, failing every call with
    // a confusing "Credit balance is too low". Strip it so the CLI stays free and
    // fails with a clear subscription message instead.
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(command, {
      cwd: process.cwd(),
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill();
        reject(new Error(`CLI command timed out after ${CLI_TIMEOUT_MS / 1000}s.`));
      });
    }, CLI_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish(() => reject(error)));
    const discardOutputFile = () => {
      if (options.outputFile) void unlink(options.outputFile).catch(() => undefined);
    };
    child.on("close", (code) => finish(() => {
      if (code !== 0) {
        // The Claude CLI writes its real error (e.g. a rate-limit notice) to
        // STDOUT, not stderr, so a bare "exit code 1" hides the reason. Surface
        // whichever stream carried the message.
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        discardOutputFile();
        reject(new Error(detail.slice(0, 800)));
        return;
      }
      // No output file (claude -p): stdout IS the answer, as before.
      if (!options.outputFile) {
        resolve({ command, stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      // Codex: read the final message it wrote, then clean the file up. Falling
      // back to stdout would hand the caller a transcript, so an unreadable file
      // resolves empty and the caller treats it as an unusable result.
      void readFile(options.outputFile, "utf8")
        .then((text) => text.trim())
        .catch(() => "")
        .then((text) => {
          discardOutputFile();
          resolve({ command, stdout: text, stderr: stderr.trim() });
        });
    }));
    child.stdin?.end(prompt);
  });
}
